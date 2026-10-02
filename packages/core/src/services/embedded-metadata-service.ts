import { eq, sql } from 'drizzle-orm'
import type { Database } from '@pb/db'
import { schema } from '@pb/db'
import { parseMakerWorldUrl, type MakerWorldModel } from '../import/makerworld'
import { basename, humanizeName } from '../library/paths'
import { readPackageSidecar, readSidecar } from '../sidecar/sidecar'
import { createStorageAdapter, libraryLocationFromRow } from '../storage/factory'
import { syncSidecar, updateModel, type ModelPatch } from './model-service'

/** Structural contract: core does not depend on the mesh/image decoder package. */
export interface EmbeddedModelMetadata {
  title?: string
  designer?: string
  description?: string
  license?: string
  creationDate?: string
  modificationDate?: string
  application?: string
  sourceIdentifiers?: Record<string, string>
}

/** Cheap preflight so variant files do not make duplicate public requests. */
export async function isEmbeddedMetadataSource(
  db: Database,
  modelId: string,
  fileId: string,
): Promise<boolean> {
  const result = await db.execute<{ id: string }>(sql`
    SELECT model_files.id FROM model_files JOIN models ON models.id = model_files.model_id
    WHERE models.id = ${modelId} AND models.embedded_metadata_state = 'pending'
      AND lower(model_files.extension) = '3mf' AND model_files.missing_at IS NULL
    ORDER BY model_files.filename COLLATE "C", model_files.id LIMIT 1
  `)
  return result.rows[0]?.id === fileId
}

/**
 * A new model gets one automatic import. Existing records, sidecars, explicit
 * edits and URL imports are authoritative, even when they intentionally clear a
 * field. Jobs for several project files cannot race their titles into the model:
 * the first live 3MF in bytewise filename order is its sole metadata source.
 */
export async function applyEmbeddedModelMetadata(
  db: Database,
  modelId: string,
  fileId: string,
  metadata: EmbeddedModelMetadata,
  source?: Pick<MakerWorldModel, 'sourceUrl' | 'tags'>,
): Promise<{ applied: boolean; reason?: string }> {
  const result = await db.transaction(async (transaction) => {
    // Drizzle transactions implement the query interface used by updateModel.
    const tx = transaction as unknown as Database
    const locked = await tx.execute<{ id: string; embedded_metadata_state: string }>(sql`
      SELECT id, embedded_metadata_state FROM models WHERE id = ${modelId} FOR UPDATE
    `)
    if (!locked.rows[0] || locked.rows[0].embedded_metadata_state !== 'pending') {
      return { applied: false, reason: 'Metadata is already authoritative.' }
    }
    const canonical = await tx.execute<{ id: string }>(sql`
      SELECT id FROM model_files
      WHERE model_id = ${modelId} AND lower(extension) = '3mf' AND missing_at IS NULL
      ORDER BY filename COLLATE "C", id LIMIT 1
    `)
    if (canonical.rows[0]?.id !== fileId) {
      return { applied: false, reason: 'Another project file is the metadata source.' }
    }
    const rows = await tx
      .select({ model: schema.models, library: schema.libraries })
      .from(schema.models)
      .innerJoin(schema.libraries, eq(schema.libraries.id, schema.models.libraryId))
      .where(eq(schema.models.id, modelId))
      .limit(1)
    const row = rows[0]!
    if (!row.model.isFileModel) {
      const storage = createStorageAdapter(libraryLocationFromRow(row.library))
      const sidecar = row.model.isPackage
        ? await readPackageSidecar(storage, row.model.path)
        : await readSidecar(storage, row.model.path)
      if (sidecar.data || sidecar.error) {
        await tx
          .update(schema.models)
          .set({ embeddedMetadataState: 'done' })
          .where(eq(schema.models.id, modelId))
        return { applied: false, reason: 'An on-disk sidecar is authoritative.' }
      }
    }

    const patch: ModelPatch = {}
    if (source) {
      // Only an exact provider mapping can supply this provenance, never the
      // opaque ids retained in the package or arbitrary embedded HTTP URLs.
      const url = parseMakerWorldUrl(source.sourceUrl).sourceUrl
      await tx
        .insert(schema.modelLinks)
        .values({
          modelId,
          url,
          host: 'makerworld.com',
          title: 'MakerWorld',
        })
        .onConflictDoNothing()
      const existingTags = await tx
        .select({ id: schema.modelTags.tagId })
        .from(schema.modelTags)
        .where(eq(schema.modelTags.modelId, modelId))
        .limit(1)
      if (!existingTags.length && source.tags.length) patch.tags = source.tags
    }
    if (metadata.title && row.model.name === humanizeName(basename(row.model.path)))
      patch.name = metadata.title
    if (metadata.designer && !row.model.creatorId) patch.creator = metadata.designer
    if (metadata.license && !row.model.license?.trim()) patch.license = metadata.license
    const notes = embeddedNotes(metadata)
    if (notes && !row.model.notes?.trim()) patch.notes = notes

    if (!Object.keys(patch).length && !source) {
      await tx
        .update(schema.models)
        .set({ embeddedMetadataState: 'done' })
        .where(eq(schema.models.id, modelId))
      return { applied: false, reason: 'The project contains no missing descriptive fields.' }
    }
    // Disk writes wait until commit; a database rollback cannot leave metadata
    // in a sidecar that was never saved to the model.
    const result = await updateModel(tx, modelId, patch, { deferSidecar: true })
    if (!result.ok) throw new Error(result.error ?? 'Could not apply embedded metadata')
    return { applied: true }
  })
  if (result.applied) await syncSidecar(db, modelId)
  return result
}

function embeddedNotes(metadata: EmbeddedModelMetadata): string {
  const parts: string[] = []
  if (metadata.description?.trim()) parts.push(metadata.description.trim())
  const provenance: string[] = []
  if (metadata.creationDate) provenance.push(`Source file creation date: ${metadata.creationDate}`)
  if (metadata.modificationDate)
    provenance.push(`Source file modification date: ${metadata.modificationDate}`)
  if (provenance.length) parts.push(provenance.join('\n'))
  return parts.join('\n\n').slice(0, 20_000)
}
