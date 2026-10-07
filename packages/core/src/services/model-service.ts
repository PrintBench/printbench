import { and, eq, inArray, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { Database } from '@pb/db'
import { schema } from '@pb/db'
import { slugify } from '../library/paths'
import { refreshModelSearchVectors } from '../search/refresh'
import {
  isValidIsoDate,
  readSidecar,
  readPackageSidecar,
  sidecarUnchanged,
  writeSidecar,
  writePackageSidecar,
  type SidecarContent,
} from '../sidecar/sidecar'
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
  licenseUrl?: string | null
  licenseExpiresAt?: string | null
  commercialUse?: boolean | null
  licenseNotes?: string | null
  /** Creator name; created if it does not exist. Empty string clears it. */
  creator?: string | null
  /** Full replacement set of tag names. Created as needed. */
  tags?: string[]
  /** Full replacement set of external links, preserved in display order. */
  links?: { title?: string | null; url: string }[]
  previewFileId?: string | null
}

export interface UpdateResult {
  ok: boolean
  error?: string
  /**
   * False when the library has sidecar writing disabled, when the content is
   * unchanged, or when writing one would re-group the library. See
   * {@link syncSidecar}.
   */
  sidecarWritten: boolean
  /** Set when saving named a creator that did not exist yet, for the audit trail. */
  creatorCreated?: { id: string; name: string }
}

const MAX_NAME = 225
const MAX_NOTES = 20_000
const MAX_TAGS = 200
const MAX_LINKS = 50
const MAX_LINK_TITLE = 300
const MAX_LINK_URL = 2000

const SINGLETON_LINK_TITLES = new Set([
  'Original model page',
  'Assembly video',
  'Printing instructions',
  'Designer page',
])

export async function updateModel(
  db: Database,
  modelId: string,
  patch: ModelPatch,
  options: { deferSidecar?: boolean } = {},
): Promise<UpdateResult> {
  const rows = await db
    .select({ model: schema.models, library: schema.libraries })
    .from(schema.models)
    .innerJoin(schema.libraries, eq(schema.libraries.id, schema.models.libraryId))
    .where(eq(schema.models.id, modelId))
    .limit(1)

  const row = rows[0]
  if (!row) return { ok: false, error: 'That model no longer exists.', sidecarWritten: false }

  const updates: Partial<typeof schema.models.$inferInsert> = {
    updatedAt: new Date(),
    embeddedMetadataState: 'done',
  }

  if (patch.links !== undefined) {
    const links = patch.links
      .map((link) => ({
        title: link.title?.trim() || null,
        url: link.url.trim(),
      }))
      .filter((link) => link.url !== '')

    if (links.length > MAX_LINKS) {
      return {
        ok: false,
        error: `A model can have at most ${MAX_LINKS} links.`,
        sidecarWritten: false,
      }
    }

    const singletonTitles = new Set<string>()

    for (const link of links) {
      if (link.url.length > MAX_LINK_URL) {
        return {
          ok: false,
          error: `Link URLs can be at most ${MAX_LINK_URL} characters.`,
          sidecarWritten: false,
        }
      }

      if (link.title !== null && link.title.length > MAX_LINK_TITLE) {
        return {
          ok: false,
          error: `Link titles can be at most ${MAX_LINK_TITLE} characters.`,
          sidecarWritten: false,
        }
      }

      if (link.title !== null && SINGLETON_LINK_TITLES.has(link.title)) {
        if (singletonTitles.has(link.title)) {
          return {
            ok: false,
            error: `Only one "${link.title}" link is allowed.`,
            sidecarWritten: false,
          }
        }
        singletonTitles.add(link.title)
      }
    }
  }

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

  if (patch.licenseUrl !== undefined) {
    const value = patch.licenseUrl?.trim() ?? ''
    updates.licenseUrl = value.length > 0 ? value.slice(0, 2000) : null
  }

  if (patch.licenseExpiresAt !== undefined) {
    const value = patch.licenseExpiresAt?.trim() ?? ''
    if (value.length > 0 && !isValidIsoDate(value)) {
      return {
        ok: false,
        error: 'Licence expiry must be a valid date in YYYY-MM-DD format.',
        sidecarWritten: false,
      }
    }
    updates.licenseExpiresAt = value.length > 0 ? value : null
  }

  if (patch.commercialUse !== undefined) {
    updates.commercialUse = patch.commercialUse
  }

  if (patch.licenseNotes !== undefined) {
    updates.licenseNotes =
      patch.licenseNotes === null ? null : patch.licenseNotes.slice(0, MAX_NOTES)
  }

  let creatorCreated: UpdateResult['creatorCreated']
  if (patch.creator !== undefined) {
    updates.creatorId = await resolveCreator(db, patch.creator, (creator) => {
      creatorCreated = creator
    })
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
        return {
          ok: false,
          error: 'That file does not belong to this model.',
          sidecarWritten: false,
        }
      }
      updates.previewFileId = patch.previewFileId
    }
  }

  await db.update(schema.models).set(updates).where(eq(schema.models.id, modelId))

  if (patch.tags !== undefined) {
    await setModelTags(db, modelId, patch.tags)
  }

  if (patch.links !== undefined) {
    await db.execute(sql`DELETE FROM model_links WHERE model_id = ${modelId}`)

    for (const [position, link] of patch.links.entries()) {
      const url = link.url.trim()
      if (!url) continue

      const title = link.title?.trim() || null
      let host: string | null = null
      try {
        host = new URL(url).hostname
      } catch {
        // Preserve non-standard URLs just as the sidecar scanner does.
      }

      await db.execute(sql`
        INSERT INTO model_links (model_id, url, title, host, position)
        VALUES (${modelId}, ${url}, ${title}, ${host}, ${position})
        ON CONFLICT (model_id, url) DO UPDATE SET
          title = EXCLUDED.title,
          host = EXCLUDED.host,
          position = EXCLUDED.position
      `)
    }
  }

  // Rebuilt in the same operation: a renamed model that is not findable by its
  // new name until some later sweep is worse than a slightly slower save.
  await refreshModelSearchVectors(db, [modelId])

  // A surrounding transaction must commit before an external filesystem write.
  const sidecarWritten = options.deferSidecar ? false : await syncSidecar(db, modelId)
  return { ok: true, sidecarWritten, creatorCreated }
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

async function resolveCreator(
  db: Database,
  name: string | null,
  onCreated?: (creator: { id: string; name: string }) => void,
): Promise<string | null> {
  const trimmed = name?.trim() ?? ''
  if (trimmed.length === 0) return null

  const existing = await db.execute<{ id: string }>(
    sql`SELECT id FROM creators WHERE lower(name) = lower(${trimmed}) LIMIT 1`,
  )
  if (existing.rows[0]) return existing.rows[0].id

  const inserted = await db.execute<{ id: string; created: boolean }>(sql`
    INSERT INTO creators (name, slug, public_id)
    VALUES (${trimmed.slice(0, 225)}, ${slugify(trimmed) || `creator-${nanoid(6)}`}, ${nanoid(12)})
    ON CONFLICT (slug) DO UPDATE SET name = creators.name
    RETURNING id, (xmax = 0) AS created
  `)
  const creator = inserted.rows[0]!
  if (creator.created) onCreated?.({ id: creator.id, name: trimmed.slice(0, 225) })
  return creator.id
}

/**
 * Writes the model's metadata back to disk.
 *
 * Skipped when the library has sidecars turned off, and skipped again when the
 * content is unchanged — rewriting an identical file would change the folder's
 * mtime and send the next fast scan back through it for nothing.
 *
 * Also skipped when another model sits inside this one's folder, which is the
 * subtle one. A sidecar is not only metadata: grouping treats it as an
 * explicit declaration that its folder is ONE model, and collapses everything
 * below it. Writing one here would mean that adding a tag silently merged the
 * models underneath at the next scan — a restructuring of the user's library
 * as a side effect of an unrelated edit. The metadata stays in the database;
 * what is given up is the disk backup for the handful of models in that state,
 * which the `nested_model` health problem is already asking the user to
 * resolve. Resolve the nesting and the next edit writes the sidecar normally.
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
  if (!row.model.isPackage && (await hasNestedModel(db, row.model.libraryId, row.model.path))) {
    return false
  }

  const content = await buildSidecarContent(db, modelId)

  const storage = createStorageAdapter({
    ...libraryLocationFromRow(row.library),
    // The sidecar is the one permitted exception to an in-place library being
    // read-only. It never touches the user's model files.
    allowWrites: true,
  })

  const { data: existing } = row.model.isPackage
    ? await readPackageSidecar(storage, row.model.path)
    : await readSidecar(storage, row.model.path)
  if (sidecarUnchanged(existing, content)) return false

  try {
    if (row.model.isPackage) {
      await writePackageSidecar(storage, row.model.path, content)
    } else {
      await writeSidecar(storage, row.model.path, content)
    }
    return true
  } catch (error) {
    // A read-only mount or a permissions problem must not fail the edit: the
    // database is still correct, and the sidecar is a convenience.
    console.warn(`[sidecar] could not write for model ${modelId}: ${String(error)}`)
    return false
  }
}

/**
 * Does another live model sit inside this one's folder?
 *
 * Nesting is derived from the path rather than stored, the same way the
 * `nested_model` health check derives it. Two differences: `starts_with`
 * rather than `LIKE`, because a real folder name may contain `%` or `_` and
 * those are wildcards to `LIKE`; and file models count too, since a collapse
 * would swallow them just the same.
 */
async function hasNestedModel(
  db: Database,
  libraryId: string,
  modelPath: string,
): Promise<boolean> {
  const result = await db.execute<{ nested: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM models child
      WHERE child.library_id = ${libraryId}
        AND child.missing_at IS NULL
        AND starts_with(child.path, ${`${modelPath}/`})
    ) AS nested
  `)
  return result.rows[0]?.nested === true
}

export async function buildSidecarContent(db: Database, modelId: string): Promise<SidecarContent> {
  const links = await db
    .select({ url: schema.modelLinks.url, title: schema.modelLinks.title })
    .from(schema.modelLinks)
    .where(eq(schema.modelLinks.modelId, modelId))
    .orderBy(schema.modelLinks.position, schema.modelLinks.url)
    .limit(50)
  const result = await db.execute<{
    name: string
    notes: string | null
    license: string | null
    license_url: string | null
    license_expires_at: string | null
    commercial_use: boolean | null
    license_notes: string | null
    creator: string | null
    tags: string[] | null
    preview_file: string | null
  }>(sql`
    SELECT m.name, m.notes, m.license,
           m.license_url, m.license_expires_at, m.commercial_use, m.license_notes,
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
    licenseUrl: row.license_url,
    licenseExpiresAt: row.license_expires_at,
    commercialUse: row.commercial_use,
    licenseNotes: row.license_notes,
    creator: row.creator,
    tags: row.tags ?? [],
    links: links.map((link) => ({
      url: link.url,
      ...(link.title ? { title: link.title } : {}),
    })),
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
  await db
    .update(schema.models)
    .set({ embeddedMetadataState: 'done' })
    .where(inArray(schema.models.id, ids))

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
        await db
          .insert(schema.modelTags)
          .values(pairs.slice(i, i + 1000))
          .onConflictDoNothing()
      }
    }
  }

  await refreshModelSearchVectors(db, ids)
  for (const id of ids) await syncSidecar(db, id)

  return { updated: ids.length }
}
