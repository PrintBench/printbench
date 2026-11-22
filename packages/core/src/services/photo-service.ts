import { sql } from 'drizzle-orm'
import type { Database } from '@pb/db'
import { getPhotoStore, photoKey } from '../previews/photo-store'

/**
 * Photographs attached to a model.
 *
 * The rendering lives in @pb/mesh, which already owns sharp; this module owns
 * the row, the link to a print run and the store keys, so the rules are the
 * same whoever writes a photo — the upload route today, an importer later.
 *
 * Like a note, a photo may name a print and may equally name none: a picture
 * of the finished thing belongs to the model, and only some pictures are
 * evidence about one particular run.
 */

/** What the upload route will accept before anything is decoded. */
export const MAX_PHOTO_UPLOAD_BYTES = 25 * 1024 * 1024
export const MAX_CAPTION_LENGTH = 300
/** Keeps one model from becoming an album. */
export const MAX_PHOTOS_PER_MODEL = 60

export class PhotoValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PhotoValidationError'
  }
}

export interface ModelPhoto {
  id: string
  modelId: string
  printRunId: string | null
  userId: string | null
  uploaderName: string | null
  caption: string | null
  imageKey: string
  thumbKey: string
  width: number
  height: number
  byteSize: number
  createdAt: Date
  printStatus: string | null
  printStartedAt: Date | null
  printCreatedAt: Date | null
}

export interface PhotoInput {
  modelId: string
  userId?: string | null
  caption?: string | null
  printRunId?: string | null
  /** Already rendered by @pb/mesh; this module only stores them. */
  image: { data: Buffer; width: number; height: number }
  thumb: { data: Buffer }
}

function cleanCaption(value: string | null | undefined): string | null {
  if (value == null) return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed.slice(0, MAX_CAPTION_LENGTH)
}

/**
 * A print may only be linked from a photo on the same model.
 *
 * Same reasoning as model notes: the id arrives from a form, and a photo
 * filed against another model's print would be invisible on the page it was
 * uploaded from.
 */
async function assertPrintBelongs(
  db: Database,
  modelId: string,
  printRunId: string,
): Promise<void> {
  const rows = await db.execute<{ ok: boolean }>(sql`
    SELECT true AS ok FROM print_runs WHERE id = ${printRunId} AND model_id = ${modelId} LIMIT 1
  `)
  if (rows.rows.length === 0) {
    throw new PhotoValidationError('That print is not one of this model’s.')
  }
}

export async function countPhotos(db: Database, modelId: string): Promise<number> {
  const rows = await db.execute<{ count: string }>(sql`
    SELECT count(*)::bigint AS count FROM model_photos WHERE model_id = ${modelId}
  `)
  return Number(rows.rows[0]?.count ?? 0)
}

/**
 * Stores both renditions and records the row.
 *
 * The files are written first. A row pointing at bytes that are not there
 * renders as a broken image on every visit; a file with no row is invisible
 * and costs a few hundred kilobytes until the orphan sweep below runs.
 */
export async function addPhoto(db: Database, input: PhotoInput): Promise<string> {
  const printRunId = input.printRunId || null
  if (printRunId) await assertPrintBelongs(db, input.modelId, printRunId)

  if ((await countPhotos(db, input.modelId)) >= MAX_PHOTOS_PER_MODEL) {
    throw new PhotoValidationError(
      `A model can hold ${MAX_PHOTOS_PER_MODEL} photos. Delete one to add another.`,
    )
  }

  const store = getPhotoStore()

  const imageKey = photoKey(input.image.data, 'image')
  const thumbKey = photoKey(input.thumb.data, 'thumb')

  await store.write(imageKey, input.image.data)
  await store.write(thumbKey, input.thumb.data)

  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO model_photos
      (model_id, print_run_id, user_id, caption, image_key, thumb_key, width, height, byte_size)
    VALUES (${input.modelId}, ${printRunId}, ${input.userId ?? null},
            ${cleanCaption(input.caption)}, ${imageKey}, ${thumbKey},
            ${input.image.width}, ${input.image.height}, ${input.image.data.byteLength})
    RETURNING id
  `)

  return rows.rows[0]!.id
}

export interface PhotoPatch {
  caption?: string | null
  /** Null unlinks the photo from its print; undefined leaves the link alone. */
  printRunId?: string | null
}

export async function updatePhoto(db: Database, photoId: string, patch: PhotoPatch): Promise<void> {
  const current = await getPhotoOwner(db, photoId)
  if (!current) throw new PhotoValidationError('That photo no longer exists.')

  const sets = []

  if (patch.caption !== undefined) sets.push(sql`caption = ${cleanCaption(patch.caption)}`)

  if (patch.printRunId !== undefined) {
    if (patch.printRunId) await assertPrintBelongs(db, current.modelId, patch.printRunId)
    sets.push(sql`print_run_id = ${patch.printRunId || null}`)
  }

  if (sets.length === 0) return
  sets.push(sql`updated_at = now()`)

  await db.execute(sql`UPDATE model_photos SET ${sql.join(sets, sql`, `)} WHERE id = ${photoId}`)
}

/**
 * Removes the row, and the files once nothing else points at them.
 *
 * Keys are content-addressed, so two uploads of the same picture share one
 * file — deleting whichever row happens to go first must not blank the other.
 */
export async function deletePhoto(db: Database, photoId: string): Promise<void> {
  const rows = await db.execute<{ image_key: string; thumb_key: string }>(sql`
    DELETE FROM model_photos WHERE id = ${photoId} RETURNING image_key, thumb_key
  `)
  const removed = rows.rows[0]
  if (!removed) return

  const store = getPhotoStore()

  for (const key of [removed.image_key, removed.thumb_key]) {
    const stillUsed = await db.execute<{ ok: boolean }>(sql`
      SELECT true AS ok FROM model_photos
      WHERE image_key = ${key} OR thumb_key = ${key} LIMIT 1
    `)
    if (stillUsed.rows.length > 0) continue

    // A file that will not delete is a few hundred kilobytes of waste, not a
    // reason to fail a delete the person already saw succeed.
    await store.delete(key).catch(() => undefined)
  }
}

export async function getPhotoOwner(
  db: Database,
  photoId: string,
): Promise<{ modelId: string; userId: string | null } | null> {
  const rows = await db.execute<{ model_id: string; user_id: string | null }>(sql`
    SELECT model_id, user_id FROM model_photos WHERE id = ${photoId} LIMIT 1
  `)
  const row = rows.rows[0]
  return row ? { modelId: row.model_id, userId: row.user_id } : null
}

/** Keys and state for the serving route, without loading the whole list. */
export async function getPhotoKeys(
  db: Database,
  photoId: string,
): Promise<{ imageKey: string; thumbKey: string } | null> {
  const rows = await db.execute<{ image_key: string; thumb_key: string }>(sql`
    SELECT image_key, thumb_key FROM model_photos WHERE id = ${photoId} LIMIT 1
  `)
  const row = rows.rows[0]
  return row ? { imageKey: row.image_key, thumbKey: row.thumb_key } : null
}

export async function listPhotos(
  db: Database,
  modelId: string,
  options: { limit?: number } = {},
): Promise<ModelPhoto[]> {
  const limit = Math.min(Math.max(options.limit ?? MAX_PHOTOS_PER_MODEL, 1), 500)

  const rows = await db.execute<{
    id: string
    model_id: string
    print_run_id: string | null
    user_id: string | null
    uploader_name: string | null
    caption: string | null
    image_key: string
    thumb_key: string
    width: number
    height: number
    byte_size: number
    created_at: string
    print_status: string | null
    print_started_at: string | null
    print_created_at: string | null
  }>(sql`
    SELECT ph.id, ph.model_id, ph.print_run_id, ph.user_id, u.name AS uploader_name,
           ph.caption, ph.image_key, ph.thumb_key, ph.width, ph.height, ph.byte_size,
           ph.created_at,
           p.status AS print_status, p.started_at AS print_started_at,
           p.created_at AS print_created_at
    FROM model_photos ph
    LEFT JOIN "user" u ON u.id = ph.user_id
    LEFT JOIN print_runs p ON p.id = ph.print_run_id
    WHERE ph.model_id = ${modelId}
    ORDER BY ph.created_at DESC, ph.id DESC
    LIMIT ${limit}
  `)

  return rows.rows.map((row) => ({
    id: row.id,
    modelId: row.model_id,
    printRunId: row.print_run_id,
    userId: row.user_id,
    uploaderName: row.uploader_name,
    caption: row.caption,
    imageKey: row.image_key,
    thumbKey: row.thumb_key,
    width: row.width,
    height: row.height,
    byteSize: row.byte_size,
    createdAt: new Date(row.created_at),
    printStatus: row.print_status,
    printStartedAt: row.print_started_at ? new Date(row.print_started_at) : null,
    printCreatedAt: row.print_created_at ? new Date(row.print_created_at) : null,
  }))
}
