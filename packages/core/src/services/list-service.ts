import { sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { Database } from '@pb/db'
import { slugify } from '../library/paths'

/**
 * Lists, and the "liked" list in particular.
 *
 * Every user has exactly one liked list, created the first time they need it
 * rather than at sign-up — an account that never likes anything should not
 * carry an empty row, and back-filling one for existing accounts would be a
 * migration for no benefit.
 *
 * Lists are per-user and private. There is no sharing of lists and no
 * collaborative editing, because that is a different feature with different
 * questions and this one is meant to be a bookmark.
 */

export interface ListSummary {
  id: string
  name: string
  slug: string
  kind: 'normal' | 'liked'
  itemCount: number
}

export class ListError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ListError'
  }
}

/**
 * The user's liked list, creating it if this is the first like.
 *
 * A partial unique index enforces one liked list per user, so a race between
 * two tabs both liking something resolves at the database rather than
 * producing two lists.
 */
export async function ensureLikedList(db: Database, userId: string): Promise<string> {
  const existing = await db.execute<{ id: string }>(
    sql`SELECT id FROM lists WHERE user_id = ${userId} AND kind = 'liked' LIMIT 1`,
  )
  if (existing.rows[0]) return existing.rows[0].id

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO lists (user_id, name, slug, kind)
    VALUES (${userId}, 'Liked', ${`liked-${nanoid(8).toLowerCase()}`}, 'liked')
    ON CONFLICT DO NOTHING
    RETURNING id`)

  if (created.rows[0]) return created.rows[0].id

  // Lost the race; the other insert won and its list is the one to use.
  const now = await db.execute<{ id: string }>(
    sql`SELECT id FROM lists WHERE user_id = ${userId} AND kind = 'liked' LIMIT 1`,
  )
  if (!now.rows[0]) throw new ListError('Could not open your liked list.')
  return now.rows[0].id
}

/** Adds or removes a like. Returns whether the model is liked afterwards. */
export async function toggleLike(
  db: Database,
  userId: string,
  modelId: string,
): Promise<{ liked: boolean }> {
  const listId = await ensureLikedList(db, userId)

  const removed = await db.execute(sql`
    DELETE FROM list_items WHERE list_id = ${listId} AND model_id = ${modelId}`)

  if ((removed.rowCount ?? 0) > 0) return { liked: false }

  await db.execute(sql`
    INSERT INTO list_items (list_id, model_id) VALUES (${listId}, ${modelId})
    ON CONFLICT DO NOTHING`)

  return { liked: true }
}

export async function isLiked(db: Database, userId: string, modelId: string): Promise<boolean> {
  const rows = await db.execute<{ ok: boolean }>(sql`
    SELECT true AS ok FROM list_items li
    JOIN lists l ON l.id = li.list_id
    WHERE l.user_id = ${userId} AND l.kind = 'liked' AND li.model_id = ${modelId}
    LIMIT 1`)
  return rows.rows.length > 0
}

/**
 * Which of these models the user has liked.
 *
 * Asked for a whole page of cards at once: a query per card turns a grid of
 * forty-eight into forty-eight round trips.
 */
export async function likedAmong(
  db: Database,
  userId: string,
  modelIds: string[],
): Promise<Set<string>> {
  if (modelIds.length === 0) return new Set()

  const rows = await db.execute<{ model_id: string }>(sql`
    SELECT li.model_id FROM list_items li
    JOIN lists l ON l.id = li.list_id
    WHERE l.user_id = ${userId} AND l.kind = 'liked'
      AND li.model_id = ANY(${sql.param(modelIds)}::uuid[])`)

  return new Set(rows.rows.map((row) => row.model_id))
}

export interface LikedModel {
  id: string
  publicId: string
  name: string
  path: string
  fileCount: number
  totalSize: number
  libraryName: string
  thumbFileId: string | null
  addedAt: Date
}

export async function listLiked(
  db: Database,
  userId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<LikedModel[]> {
  const limit = Math.min(Math.max(options.limit ?? 60, 1), 200)

  const rows = await db.execute<{
    id: string
    public_id: string
    name: string
    path: string
    file_count: number
    total_size: string
    library_name: string
    thumb_file_id: string | null
    added_at: string
  }>(sql`
    SELECT m.id, m.public_id, m.name, m.path, m.file_count, m.total_size,
           l.name AS library_name, li.created_at AS added_at,
           (SELECT f.id FROM model_files f
             WHERE f.model_id = m.id AND f.thumb_state = 'ok' AND f.missing_at IS NULL
             ORDER BY f.size DESC LIMIT 1) AS thumb_file_id
    FROM list_items li
    JOIN lists lst ON lst.id = li.list_id
    JOIN models m ON m.id = li.model_id
    JOIN libraries l ON l.id = m.library_id
    WHERE lst.user_id = ${userId} AND lst.kind = 'liked' AND m.missing_at IS NULL
    -- Most recently liked first: the reason you liked it is usually recent.
    ORDER BY li.created_at DESC
    LIMIT ${limit} OFFSET ${Math.max(options.offset ?? 0, 0)}`)

  return rows.rows.map((row) => ({
    id: row.id,
    publicId: row.public_id,
    name: row.name,
    path: row.path,
    fileCount: row.file_count,
    totalSize: Number(row.total_size),
    libraryName: row.library_name,
    thumbFileId: row.thumb_file_id,
    addedAt: new Date(row.added_at),
  }))
}

export async function likedCount(db: Database, userId: string): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM list_items li
    JOIN lists l ON l.id = li.list_id
    JOIN models m ON m.id = li.model_id
    WHERE l.user_id = ${userId} AND l.kind = 'liked' AND m.missing_at IS NULL`)
  return rows.rows[0]?.n ?? 0
}

/** Named lists beyond the liked one. Kept simple: create, rename, delete. */
export async function listsFor(db: Database, userId: string): Promise<ListSummary[]> {
  const rows = await db.execute<{
    id: string
    name: string
    slug: string
    kind: 'normal' | 'liked'
    item_count: number
  }>(sql`
    SELECT l.id, l.name, l.slug, l.kind, count(li.model_id)::int AS item_count
    FROM lists l
    LEFT JOIN list_items li ON li.list_id = l.id
    WHERE l.user_id = ${userId}
    GROUP BY l.id
    -- Liked first; it is the one people mean.
    ORDER BY (l.kind = 'liked') DESC, l.name ASC`)

  return rows.rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    kind: row.kind,
    itemCount: row.item_count,
  }))
}

export async function createList(
  db: Database,
  userId: string,
  name: string,
): Promise<{ id: string; slug: string }> {
  const trimmed = name.trim()
  if (!trimmed) throw new ListError('A list needs a name.')
  if (trimmed.length > 120) throw new ListError('Keep list names under 120 characters.')

  const rows = await db.execute<{ id: string; slug: string }>(sql`
    INSERT INTO lists (user_id, name, slug, kind)
    VALUES (${userId}, ${trimmed},
            ${`${slugify(trimmed) || 'list'}-${nanoid(6).toLowerCase()}`}, 'normal')
    RETURNING id, slug`)

  return rows.rows[0]!
}

/**
 * Deletes a list the user owns.
 *
 * The liked list cannot be deleted — it is recreated on the next like anyway,
 * so removing it only loses the likes.
 */
export async function deleteList(db: Database, userId: string, listId: string): Promise<void> {
  const rows = await db.execute<{ kind: string }>(
    sql`SELECT kind FROM lists WHERE id = ${listId} AND user_id = ${userId} LIMIT 1`,
  )
  const list = rows.rows[0]
  if (!list) throw new ListError('That list no longer exists.')
  if (list.kind === 'liked') throw new ListError('The liked list cannot be removed.')

  await db.execute(sql`DELETE FROM lists WHERE id = ${listId} AND user_id = ${userId}`)
}
