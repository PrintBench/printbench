import { sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { Database } from '@pb/db'
import { slugify } from '../library/paths'
import { refreshModelSearchVectors } from '../search/refresh'

/**
 * Browsing by creator, tag and collection.
 *
 * These are the three ways a print library is navigated when you do not already
 * know what you are looking for, and they are all the same shape: a list with
 * counts, and a page showing what is in one of them. Search covers the case
 * where you do know.
 *
 * Counts always exclude models missing from disk. A creator page claiming
 * forty models when eight of them are on an unplugged drive is worse than
 * useless — it sends you looking for something that is not there.
 */

export interface CreatorSummary {
  id: string
  name: string
  slug: string
  publicId: string
  notes: string | null
  modelCount: number
  /** A model with a rendered thumbnail, for the card. */
  previewFileId: string | null
}

export interface TagSummary {
  id: string
  name: string
  slug: string
  color: string | null
  modelCount: number
}

export interface CollectionSummary {
  id: string
  name: string
  slug: string
  publicId: string
  caption: string | null
  parentId: string | null
  /** Models directly in this collection, not counting children. */
  modelCount: number
  previewFileId: string | null
}

export class BrowseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowseError'
  }
}

/* ------------------------------------------------------------------ creators */

export async function listCreators(db: Database): Promise<CreatorSummary[]> {
  const rows = await db.execute<{
    id: string
    name: string
    slug: string
    public_id: string
    notes: string | null
    model_count: number
    preview_file_id: string | null
  }>(sql`
    SELECT c.id, c.name, c.slug, c.public_id, c.notes,
           count(m.id)::int AS model_count,
           (SELECT f.id FROM model_files f
              JOIN models fm ON fm.id = f.model_id
             WHERE fm.creator_id = c.id AND f.thumb_state = 'ok' AND f.missing_at IS NULL
             ORDER BY f.size DESC LIMIT 1) AS preview_file_id
    FROM creators c
    LEFT JOIN models m ON m.creator_id = c.id AND m.missing_at IS NULL
    GROUP BY c.id
    -- Busiest first: a creator with one model is rarely what you are after.
    ORDER BY count(m.id) DESC, c.name ASC`)

  return rows.rows.map(toCreator)
}

export async function creatorBySlug(db: Database, slug: string): Promise<CreatorSummary | null> {
  const rows = await db.execute<{
    id: string
    name: string
    slug: string
    public_id: string
    notes: string | null
    model_count: number
    preview_file_id: string | null
  }>(sql`
    SELECT c.id, c.name, c.slug, c.public_id, c.notes,
           (SELECT count(*)::int FROM models m
             WHERE m.creator_id = c.id AND m.missing_at IS NULL) AS model_count,
           NULL::uuid AS preview_file_id
    FROM creators c WHERE c.slug = ${slug} LIMIT 1`)

  const row = rows.rows[0]
  return row ? toCreator(row) : null
}

function toCreator(row: {
  id: string
  name: string
  slug: string
  public_id: string
  notes: string | null
  model_count: number
  preview_file_id: string | null
}): CreatorSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    publicId: row.public_id,
    notes: row.notes,
    modelCount: row.model_count,
    previewFileId: row.preview_file_id,
  }
}

/* ---------------------------------------------------------------------- tags */

export async function listTags(db: Database): Promise<TagSummary[]> {
  const rows = await db.execute<{
    id: string
    name: string
    slug: string
    color: string | null
    model_count: number
  }>(sql`
    SELECT t.id, t.name, t.slug, t.color, count(m.id)::int AS model_count
    FROM tags t
    LEFT JOIN model_tags mt ON mt.tag_id = t.id
    LEFT JOIN models m ON m.id = mt.model_id AND m.missing_at IS NULL
    GROUP BY t.id
    ORDER BY count(m.id) DESC, t.name ASC`)

  return rows.rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    color: row.color,
    modelCount: row.model_count,
  }))
}

export async function tagBySlug(db: Database, slug: string): Promise<TagSummary | null> {
  const rows = await db.execute<{
    id: string
    name: string
    slug: string
    color: string | null
    model_count: number
  }>(sql`
    SELECT t.id, t.name, t.slug, t.color,
           (SELECT count(*)::int FROM model_tags mt JOIN models m ON m.id = mt.model_id
             WHERE mt.tag_id = t.id AND m.missing_at IS NULL) AS model_count
    FROM tags t WHERE t.slug = ${slug} LIMIT 1`)

  const row = rows.rows[0]
  return row
    ? {
        id: row.id,
        name: row.name,
        slug: row.slug,
        color: row.color,
        modelCount: row.model_count,
      }
    : null
}

export async function renameTag(db: Database, tagId: string, name: string): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed) throw new BrowseError('A tag needs a name.')
  if (trimmed.length > 60) throw new BrowseError('Keep tag names under 60 characters.')

  /*
   * Renaming onto an existing name is a merge, not an error. Anything else
   * either fails on the unique index or leaves two tags that look identical,
   * and "dragon" vs "Dragon" is exactly how that happens.
   */
  const existing = await db.execute<{ id: string }>(
    sql`SELECT id FROM tags WHERE lower(name) = lower(${trimmed}) AND id <> ${tagId} LIMIT 1`,
  )
  if (existing.rows[0]) {
    await mergeTags(db, tagId, existing.rows[0].id)
    return
  }

  await db.execute(sql`
    UPDATE tags SET name = ${trimmed}, slug = ${await freeTagSlug(db, trimmed, tagId)}
    WHERE id = ${tagId}`)

  await refreshForTag(db, tagId)
}

/**
 * A slug not already taken by another tag.
 *
 * Names are unique case-insensitively, but slugs are not derived injectively:
 * "Dragon!" and "Dragon?" both reduce to "dragon". Without this the second
 * rename fails on the unique index with an error nobody can act on.
 */
async function freeTagSlug(db: Database, name: string, exceptId: string): Promise<string> {
  const base = slugify(name) || `tag-${nanoid(6)}`

  const clash = await db.execute<{ id: string }>(
    sql`SELECT id FROM tags WHERE slug = ${base} AND id <> ${exceptId} LIMIT 1`,
  )
  return clash.rows[0] ? `${base}-${nanoid(6).toLowerCase()}` : base
}

/** Moves every model from one tag to another and deletes the source. */
export async function mergeTags(db: Database, fromId: string, intoId: string): Promise<number> {
  if (fromId === intoId) throw new BrowseError('That is the same tag.')

  const affected = await db.execute<{ model_id: string }>(
    sql`SELECT model_id FROM model_tags WHERE tag_id = ${fromId}`,
  )

  // ON CONFLICT: a model tagged with both already has the target row.
  await db.execute(sql`
    INSERT INTO model_tags (model_id, tag_id)
    SELECT model_id, ${intoId} FROM model_tags WHERE tag_id = ${fromId}
    ON CONFLICT DO NOTHING`)

  await db.execute(sql`DELETE FROM tags WHERE id = ${fromId}`)

  const modelIds = affected.rows.map((row) => row.model_id)
  if (modelIds.length > 0) await refreshModelSearchVectors(db, modelIds)

  return modelIds.length
}

export async function setTagColor(
  db: Database,
  tagId: string,
  color: string | null,
): Promise<void> {
  if (color && !/^#[0-9a-f]{6}$/i.test(color)) {
    throw new BrowseError('Colour must be a hex value like #1a2b3c.')
  }
  await db.execute(sql`UPDATE tags SET color = ${color} WHERE id = ${tagId}`)
}

/**
 * Removes a tag entirely.
 *
 * The models keep everything else; only the association goes. Search vectors
 * are rebuilt because tag names are weighted into them.
 */
export async function deleteTag(db: Database, tagId: string): Promise<number> {
  const affected = await db.execute<{ model_id: string }>(
    sql`SELECT model_id FROM model_tags WHERE tag_id = ${tagId}`,
  )
  await db.execute(sql`DELETE FROM tags WHERE id = ${tagId}`)

  const modelIds = affected.rows.map((row) => row.model_id)
  if (modelIds.length > 0) await refreshModelSearchVectors(db, modelIds)
  return modelIds.length
}

async function refreshForTag(db: Database, tagId: string): Promise<void> {
  const rows = await db.execute<{ model_id: string }>(
    sql`SELECT model_id FROM model_tags WHERE tag_id = ${tagId}`,
  )
  const ids = rows.rows.map((row) => row.model_id)
  if (ids.length > 0) await refreshModelSearchVectors(db, ids)
}

/* --------------------------------------------------------------- collections */

export async function listCollections(db: Database): Promise<CollectionSummary[]> {
  const rows = await db.execute<{
    id: string
    name: string
    slug: string
    public_id: string
    caption: string | null
    parent_id: string | null
    model_count: number
    preview_file_id: string | null
  }>(sql`
    SELECT c.id, c.name, c.slug, c.public_id, c.caption, c.parent_id,
           count(cm.model_id)::int AS model_count,
           (SELECT f.id FROM collection_models x
              JOIN model_files f ON f.model_id = x.model_id
             WHERE x.collection_id = c.id AND f.thumb_state = 'ok' AND f.missing_at IS NULL
             ORDER BY f.size DESC LIMIT 1) AS preview_file_id
    FROM collections c
    LEFT JOIN collection_models cm ON cm.collection_id = c.id
    LEFT JOIN models m ON m.id = cm.model_id AND m.missing_at IS NULL
    GROUP BY c.id
    ORDER BY c.name ASC`)

  return rows.rows.map(toCollection)
}

export async function collectionBySlug(
  db: Database,
  slug: string,
): Promise<CollectionSummary | null> {
  const rows = await db.execute<{
    id: string
    name: string
    slug: string
    public_id: string
    caption: string | null
    parent_id: string | null
    model_count: number
    preview_file_id: string | null
  }>(sql`
    SELECT c.id, c.name, c.slug, c.public_id, c.caption, c.parent_id,
           (SELECT count(*)::int FROM collection_models cm
              JOIN models m ON m.id = cm.model_id
             WHERE cm.collection_id = c.id AND m.missing_at IS NULL) AS model_count,
           NULL::uuid AS preview_file_id
    FROM collections c WHERE c.slug = ${slug} LIMIT 1`)

  const row = rows.rows[0]
  return row ? toCollection(row) : null
}

function toCollection(row: {
  id: string
  name: string
  slug: string
  public_id: string
  caption: string | null
  parent_id: string | null
  model_count: number
  preview_file_id: string | null
}): CollectionSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    publicId: row.public_id,
    caption: row.caption,
    parentId: row.parent_id,
    modelCount: row.model_count,
    previewFileId: row.preview_file_id,
  }
}

export async function createCollection(
  db: Database,
  input: { name: string; caption?: string | null; parentId?: string | null },
): Promise<{ id: string; slug: string }> {
  const name = input.name.trim()
  if (!name) throw new BrowseError('A collection needs a name.')
  if (name.length > 200) throw new BrowseError('Keep collection names under 200 characters.')

  // Slugs are unique, and two people naming a collection "Terrain" is normal.
  const base = slugify(name) || 'collection'
  const slug = `${base}-${nanoid(6).toLowerCase()}`

  const rows = await db.execute<{ id: string; slug: string }>(sql`
    INSERT INTO collections (name, slug, public_id, caption, parent_id)
    VALUES (${name}, ${slug}, ${nanoid(12)}, ${input.caption?.trim() || null},
            ${input.parentId ?? null})
    RETURNING id, slug`)

  return rows.rows[0]!
}

export async function renameCollection(
  db: Database,
  collectionId: string,
  name: string,
): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed) throw new BrowseError('A collection needs a name.')
  await db.execute(sql`UPDATE collections SET name = ${trimmed} WHERE id = ${collectionId}`)
}

export async function deleteCollection(db: Database, collectionId: string): Promise<void> {
  /*
   * Only the grouping goes; the models are untouched. Children are re-parented
   * to this collection's parent rather than deleted, because deleting a folder
   * should never take its contents with it.
   */
  await db.execute(sql`
    UPDATE collections SET parent_id = (SELECT parent_id FROM collections WHERE id = ${collectionId})
    WHERE parent_id = ${collectionId}`)
  await db.execute(sql`DELETE FROM collections WHERE id = ${collectionId}`)
}

export async function addModelToCollection(
  db: Database,
  collectionId: string,
  modelId: string,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO collection_models (collection_id, model_id)
    VALUES (${collectionId}, ${modelId})
    ON CONFLICT DO NOTHING`)
}

export async function removeModelFromCollection(
  db: Database,
  collectionId: string,
  modelId: string,
): Promise<void> {
  await db.execute(sql`
    DELETE FROM collection_models
    WHERE collection_id = ${collectionId} AND model_id = ${modelId}`)
}

/** Which collections a model belongs to, for its detail page. */
export async function collectionsForModel(
  db: Database,
  modelId: string,
): Promise<{ id: string; name: string; slug: string }[]> {
  const rows = await db.execute<{ id: string; name: string; slug: string }>(sql`
    SELECT c.id, c.name, c.slug FROM collections c
    JOIN collection_models cm ON cm.collection_id = c.id
    WHERE cm.model_id = ${modelId}
    ORDER BY c.name`)
  return rows.rows
}
