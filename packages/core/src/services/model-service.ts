import { and, eq, inArray, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { Database } from '@pm/db'
import { schema } from '@pm/db'
import { slugify } from '../library/paths'
import { refreshModelSearchVectors } from '../search/refresh'
import { readSidecar, sidecarUnchanged, writeSidecar, type SidecarContent } from '../sidecar/sidecar'
import { createStorageAdapter, libraryLocationFromRow } from '../storage/factory'

/**
 * Editing a model's metadata.
 *
 * Every mutation flows through here so three things always happen together:
 * the row is updated, the search vector is rebuilt, and the on-disk sidecar is
 * refreshed. Doing any one of those in a route handler is how they drift.
 */

export interface ModelPatch {
  name?: string
  notes?: string | null
  license?: string | null
  /** Creator name; created if it does not exist. Empty string clears it. */
  creator?: string | null
  /** Full replacement set of tag names. Created as needed. */
  tags?: string[]
  previewFileId?: string | null
}

export interface UpdateResult {
  ok: boolean
  error?: string
  /** False when the library is read-only and has sidecar writing disabled. */
  sidecarWritten: boolean
}

const MAX_NAME = 225
const MAX_NOTES = 20_000
const MAX_TAGS = 200

export async function updateModel(
  db: Database,
  modelId: string,
  patch: ModelPatch,
): Promise<UpdateResult> {
  const rows = await db
    .select({ model: schema.models, library: schema.libraries })
    .from(schema.models)
    .innerJoin(schema.libraries, eq(schema.libraries.id, schema.models.libraryId))
    .where(eq(schema.models.id, modelId))
    .limit(1)

  const row = rows[0]
  if (!row) return { ok: false, error: 'That model no longer exists.', sidecarWritten: false }

  const updates: Partial<typeof schema.models.$inferInsert> = { updatedAt: new Date() }

  if (patch.name !== undefined) {
    const name = patch.name.trim()
    if (name.length === 0) {
      return { ok: false, error: 'A model needs a name.', sidecarWritten: false }
    }
    updates.name = name.slice(0, MAX_NAME)
    updates.slug = slugify(name) || 'model'
  }

  if (patch.notes !== undefined) {
    updates.notes = patch.notes === null ? null : patch.notes.slice(0, MAX_NOTES)
  }

  if (patch.license !== undefined) {
    const license = patch.license?.trim() ?? ''
    // Empty is stored as null: "unknown licence" and "no licence" are the same
    // thing here, and null keeps the facet clean.
    updates.license = license.length > 0 ? license : null
  }

  if (patch.creator !== undefined) {
    updates.creatorId = await resolveCreator(db, patch.creator)
  }

  if (patch.previewFileId !== undefined) {
    if (patch.previewFileId === null) {
      updates.previewFileId = null
    } else {
      // The chosen preview must belong to this model, or a request could point
      // one model's card at another's image.
      const belongs = await db
        .select({ id: schema.modelFiles.id })
        .from(schema.modelFiles)
        .where(
          and(
            eq(schema.modelFiles.id, patch.previewFileId),
            eq(schema.modelFiles.modelId, modelId),
          ),
        )
        .limit(1)
      if (!belongs[0]) {
        return { ok: false, error: 'That file does not belong to this model.', sidecarWritten: false }
      }
      updates.previewFileId = patch.previewFileId
    }
  }

  await db.update(schema.models).set(updates).where(eq(schema.models.id, modelId))

  if (patch.tags !== undefined) {
    await setModelTags(db, modelId, patch.tags)
  }

  // Rebuilt in the same operation: a renamed model that is not findable by its
  // new name until some later sweep is worse than a slightly slower save.
  await refreshModelSearchVectors(db, [modelId])

  const sidecarWritten = await syncSidecar(db, modelId)
  return { ok: true, sidecarWritten }
}

/** Replaces a model's tags, creating any that do not exist. */
export async function setModelTags(
  db: Database,
  modelId: string,
  names: string[],
): Promise<string[]> {
  const cleaned = [
    ...new Set(
      names
        .map((name) => name.trim())
        .filter((name) => name.length > 0 && name.length <= 120)
        .slice(0, MAX_TAGS),
    ),
  ]

  await db.delete(schema.modelTags).where(eq(schema.modelTags.modelId, modelId))
  if (cleaned.length === 0) return []

  const ids: string[] = []
  for (const name of cleaned) {
    ids.push(await resolveTag(db, name))
  }

  await db
    .insert(schema.modelTags)
    .values(ids.map((tagId) => ({ modelId, tagId })))
    .onConflictDoNothing()

  return cleaned
}

/**
 * Finds or creates a tag by name, case-insensitively.
 *
 * "Dragon" and "dragon" must be one tag; two spellings of the same thing split
 * the facet and make both halves useless.
 */
async function resolveTag(db: Database, name: string): Promise<string> {
  const existing = await db.execute<{ id: string }>(
    sql`SELECT id FROM tags WHERE lower(name) = lower(${name}) LIMIT 1`,
  )
  if (existing.rows[0]) return existing.rows[0].id

  const slug = slugify(name) || `tag-${nanoid(6)}`
  const inserted = await db.execute<{ id: string }>(sql`
    INSERT INTO tags (name, slug) VALUES (${name}, ${slug})
    ON CONFLICT (slug) DO UPDATE SET name = tags.name
    RETURNING id
  `)
  return inserted.rows[0]!.id
}

async function resolveCreator(db: Database, name: string | null): Promise<string | null> {
  const trimmed = name?.trim() ?? ''
  if (trimmed.length === 0) return null

  const existing = await db.execute<{ id: string }>(
    sql`SELECT id FROM creators WHERE lower(name) = lower(${trimmed}) LIMIT 1`,
  )
  if (existing.rows[0]) return existing.rows[0].id

  const inserted = await db.execute<{ id: string }>(sql`
    INSERT INTO creators (name, slug, public_id)
    VALUES (${trimmed.slice(0, 225)}, ${slugify(trimmed) || `creator-${nanoid(6)}`}, ${nanoid(12)})
    ON CONFLICT (slug) DO UPDATE SET name = creators.name
    RETURNING id
  `)
  return inserted.rows[0]!.id
}

/**
 * Writes the model's metadata back to disk.
 *
 * Skipped when the library has sidecars turned off, and skipped again when the
 * content is unchanged — rewriting an identical file would change the folder's
 * mtime and send the next fast scan back through it for nothing.
 */
export async function syncSidecar(db: Database, modelId: string): Promise<boolean> {
  const rows = await db
    .select({ model: schema.models, library: schema.libraries })
    .from(schema.models)
    .innerJoin(schema.libraries, eq(schema.libraries.id, schema.models.libraryId))
    .where(eq(schema.models.id, modelId))
    .limit(1)

  const row = rows[0]
  if (!row || !row.library.writeSidecar) return false
  // A single loose file has no folder of its own to put a sidecar in.
  if (row.model.isFileModel) return false

  const content = await buildSidecarContent(db, modelId)

  const storage = createStorageAdapter({
    ...libraryLocationFromRow(row.library),
    // The sidecar is the one permitted exception to an in-place library being
    // read-only. It never touches the user's model files.
    allowWrites: true,
  })

  const { data: existing } = await readSidecar(storage, row.model.path)
  if (sidecarUnchanged(existing, content)) return false

  try {
    await writeSidecar(storage, row.model.path, content)
    return true
  } catch (error) {
    // A read-only mount or a permissions problem must not fail the edit: the
    // database is still correct, and the sidecar is a convenience.
    console.warn(`[sidecar] could not write for model ${modelId}: ${String(error)}`)
    return false
  }
}

export async function buildSidecarContent(
  db: Database,
  modelId: string,
): Promise<SidecarContent> {
  const result = await db.execute<{
    name: string
    notes: string | null
    license: string | null
    creator: string | null
    tags: string[] | null
    preview_file: string | null
  }>(sql`
    SELECT m.name, m.notes, m.license,
           c.name AS creator,
           (SELECT array_agg(t.name ORDER BY t.name)
              FROM model_tags mt JOIN tags t ON t.id = mt.tag_id
             WHERE mt.model_id = m.id) AS tags,
           pf.filename AS preview_file
    FROM models m
    LEFT JOIN creators c ON c.id = m.creator_id
    LEFT JOIN model_files pf ON pf.id = m.preview_file_id
    WHERE m.id = ${modelId}
  `)

  const row = result.rows[0]
  if (!row) return {}

  return {
    name: row.name,
    notes: row.notes,
    license: row.license,
    creator: row.creator,
    tags: row.tags ?? [],
    previewFile: row.preview_file,
  }
}

/**
 * Applies metadata to many models at once.
 *
 * Tags are added rather than replaced here: bulk-tagging a selection should not
 * silently wipe tags those models already carry, which is the behaviour people
 * expect from "add tag to selected" and not from "set tags".
 */
export async function bulkUpdateModels(
  db: Database,
  modelIds: string[],
  patch: { addTags?: string[]; creator?: string | null; license?: string | null },
): Promise<{ updated: number }> {
  if (modelIds.length === 0) return { updated: 0 }
  const ids = modelIds.slice(0, 1000)

  if (patch.creator !== undefined) {
    const creatorId = await resolveCreator(db, patch.creator)
    await db
      .update(schema.models)
      .set({ creatorId, updatedAt: new Date() })
      .where(inArray(schema.models.id, ids))
  }

  if (patch.license !== undefined) {
    const license = patch.license?.trim() ?? ''
    await db
      .update(schema.models)
      .set({ license: license.length > 0 ? license : null, updatedAt: new Date() })
      .where(inArray(schema.models.id, ids))
  }

  if (patch.addTags?.length) {
    const tagIds: string[] = []
    for (const name of patch.addTags.map((t) => t.trim()).filter(Boolean)) {
      tagIds.push(await resolveTag(db, name))
    }
    const pairs = ids.flatMap((modelId) => tagIds.map((tagId) => ({ modelId, tagId })))
    if (pairs.length > 0) {
      // Chunked: a thousand models times several tags exceeds sensible
      // parameter counts for one statement.
      for (let i = 0; i < pairs.length; i += 1000) {
        await db.insert(schema.modelTags).values(pairs.slice(i, i + 1000)).onConflictDoNothing()
      }
    }
  }

  await refreshModelSearchVectors(db, ids)
  for (const id of ids) await syncSidecar(db, id)

  return { updated: ids.length }
}
