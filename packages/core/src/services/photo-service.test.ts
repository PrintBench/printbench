// @covers BROWSE-003
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { createDb } from '@pb/db'
import { logPrint } from './print-service'
import {
  MAX_PHOTOS_PER_MODEL,
  PhotoValidationError,
  addPhoto,
  countPhotos,
  deletePhoto,
  getPhotoKeys,
  getPhotoOwner,
  listPhotos,
  updatePhoto,
} from './photo-service'
import { getPhotoStore } from '../previews/photo-store'

/**
 * Model photographs.
 *
 * The store is the only copy of what someone uploaded, so the tests that
 * matter are about the files, not the rows: that both renditions land, that
 * a delete takes them with it, and that a delete does NOT take them when a
 * second row shares the same content-addressed key.
 */

const url = process.env.DATABASE_URL

const LIB = '7f000000-0000-4000-8000-000000000001'
const MODEL = '7faa0000-0000-4000-8000-00000000000a'
const OTHER = '7faa0000-0000-4000-8000-00000000000b'
const USER = 'photo-test-user'

/** Renditions are rendered by @pb/mesh; this module only stores what it is given. */
function picture(seed: string) {
  return {
    image: { data: Buffer.from(`image:${seed}`), width: 1200, height: 900 },
    thumb: { data: Buffer.from(`thumb:${seed}`) },
  }
}

describe('model photos', { tags: ['integration'] }, () => {
  let pool: ReturnType<typeof createDb>['pool']
  let db: ReturnType<typeof createDb>['db']
  let dataDir: string

  beforeAll(async () => {
    // The shared store is a singleton resolved from DATA_DIR on first use, so
    // this must be set before anything touches it.
    dataDir = await mkdtemp(path.join(tmpdir(), 'pb-photo-svc-'))
    process.env.DATA_DIR = dataDir
    ;({ pool, db } = createDb(url))
    await cleanup()

    await db.execute(sql`
      INSERT INTO "user" (id, name, email, email_verified)
      VALUES (${USER}, 'Photo Tester', 'photo-tester@example.test', true)`)

    await db.execute(sql`
      INSERT INTO libraries (id, name, kind, backend, path)
      VALUES (${LIB}, 'Photo Fixture', 'in_place', 'local', '/fixtures/photos')`)

    for (const [id, suffix, name] of [
      [MODEL, 'a', 'Photographed Model'],
      [OTHER, 'b', 'Other Photo Model'],
    ] as [string, string, string][]) {
      await db.execute(sql`
        INSERT INTO models (id, library_id, path, name, slug, public_id, file_count, total_size)
        VALUES (${id}, ${LIB}, ${'p/' + suffix}, ${name}, ${'p-' + suffix},
                ${'mdp00000000' + suffix}, 1, 1000)`)
    }
  })

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM model_photos WHERE model_id IN (${MODEL}, ${OTHER})`)
    await db.execute(sql`DELETE FROM print_runs WHERE model_id IN (${MODEL}, ${OTHER})`)
  })

  afterAll(async () => {
    await cleanup()
    await pool.end()
    await rm(dataDir, { recursive: true, force: true })
  })

  async function cleanup() {
    await db.execute(sql`DELETE FROM model_photos WHERE model_id IN (${MODEL}, ${OTHER})`)
    await db.execute(sql`DELETE FROM print_runs WHERE model_id IN (${MODEL}, ${OTHER})`)
    await db.execute(sql`DELETE FROM models WHERE library_id = ${LIB}`)
    await db.execute(sql`DELETE FROM libraries WHERE id = ${LIB}`)
    await db.execute(sql`DELETE FROM "user" WHERE id = ${USER}`)
  }

  describe('adding', () => {
    it('stores both renditions and records their size', async () => {
      const id = await addPhoto(db, {
        modelId: MODEL,
        userId: USER,
        caption: '  Second attempt  ',
        ...picture('one'),
      })

      const keys = await getPhotoKeys(db, id)
      const store = getPhotoStore()
      expect(await store.has(keys!.imageKey)).toBe(true)
      expect(await store.has(keys!.thumbKey)).toBe(true)

      const photos = await listPhotos(db, MODEL)
      expect(photos[0]).toMatchObject({
        caption: 'Second attempt',
        width: 1200,
        height: 900,
        printRunId: null,
        uploaderName: 'Photo Tester',
      })
      expect(photos[0]!.byteSize).toBeGreaterThan(0)
    })

    it('keeps an empty caption as no caption rather than an empty string', async () => {
      await addPhoto(db, { modelId: MODEL, caption: '   ', ...picture('blank') })
      expect((await listPhotos(db, MODEL))[0]!.caption).toBeNull()
    })

    it('attaches a photo to a print of the same model', async () => {
      const { id: printId } = await logPrint(db, { modelId: MODEL, status: 'partial' })
      await addPhoto(db, { modelId: MODEL, printRunId: printId, ...picture('linked') })

      expect((await listPhotos(db, MODEL))[0]).toMatchObject({
        printRunId: printId,
        printStatus: 'partial',
      })
    })

    it('refuses a print belonging to another model', async () => {
      const { id: elsewhere } = await logPrint(db, { modelId: OTHER })

      await expect(
        addPhoto(db, { modelId: MODEL, printRunId: elsewhere, ...picture('wrong') }),
      ).rejects.toThrow(PhotoValidationError)

      expect(await listPhotos(db, MODEL)).toHaveLength(0)
    })

    /* An album is somebody else's product; this is a print log. */
    it('stops once the model is full', async () => {
      await db.execute(sql`
        INSERT INTO model_photos (model_id, image_key, thumb_key, width, height, byte_size)
        SELECT ${MODEL}, 'aa/bb/' || lpad(i::text, 36, '0') || '.webp',
               'cc/dd/' || lpad(i::text, 36, '0') || '.webp', 10, 10, 10
        FROM generate_series(1, ${MAX_PHOTOS_PER_MODEL}) AS i`)

      await expect(addPhoto(db, { modelId: MODEL, ...picture('overflow') })).rejects.toThrow(
        PhotoValidationError,
      )
      expect(await countPhotos(db, MODEL)).toBe(MAX_PHOTOS_PER_MODEL)
    })
  })

  describe('editing', () => {
    it('changes the caption and the print it belongs to', async () => {
      const { id: printId } = await logPrint(db, { modelId: MODEL })
      const id = await addPhoto(db, { modelId: MODEL, caption: 'Before', ...picture('edit') })

      await updatePhoto(db, id, { caption: 'After', printRunId: printId })

      expect((await listPhotos(db, MODEL))[0]).toMatchObject({
        caption: 'After',
        printRunId: printId,
      })
    })

    it('leaves the link alone when the patch does not mention it', async () => {
      const { id: printId } = await logPrint(db, { modelId: MODEL })
      const id = await addPhoto(db, { modelId: MODEL, printRunId: printId, ...picture('keep') })

      await updatePhoto(db, id, { caption: 'Renamed' })

      expect((await listPhotos(db, MODEL))[0]!.printRunId).toBe(printId)
    })

    it('refuses to move a photo onto another model print', async () => {
      const { id: elsewhere } = await logPrint(db, { modelId: OTHER })
      const id = await addPhoto(db, { modelId: MODEL, ...picture('move') })

      await expect(updatePhoto(db, id, { printRunId: elsewhere })).rejects.toThrow(
        PhotoValidationError,
      )
    })
  })

  describe('deleting', () => {
    it('removes the row and both files', async () => {
      const id = await addPhoto(db, { modelId: MODEL, ...picture('gone') })
      const keys = (await getPhotoKeys(db, id))!

      await deletePhoto(db, id)

      const store = getPhotoStore()
      expect(await listPhotos(db, MODEL)).toHaveLength(0)
      expect(await store.has(keys.imageKey)).toBe(false)
      expect(await store.has(keys.thumbKey)).toBe(false)
    })

    /*
     * Keys are content-addressed, so uploading the same picture twice gives
     * one file and two rows. Deleting either row must not blank the other.
     */
    it('keeps the files while another photo shares them', async () => {
      const same = picture('shared')
      const first = await addPhoto(db, { modelId: MODEL, ...same })
      const second = await addPhoto(db, { modelId: OTHER, ...same })
      const keys = (await getPhotoKeys(db, first))!

      await deletePhoto(db, first)

      const store = getPhotoStore()
      expect(await store.has(keys.imageKey)).toBe(true)
      expect(await store.has(keys.thumbKey)).toBe(true)

      await deletePhoto(db, second)
      expect(await store.has(keys.imageKey)).toBe(false)
    })

    it('is quiet about a photo that is already gone', async () => {
      const id = await addPhoto(db, { modelId: MODEL, ...picture('twice') })
      await deletePhoto(db, id)
      await expect(deletePhoto(db, id)).resolves.toBeUndefined()
      expect(await getPhotoOwner(db, id)).toBeNull()
    })
  })

  /* Deleting a print should not throw away the picture of what it made. */
  it('keeps a photo when its print is deleted, and drops the link', async () => {
    const { id: printId } = await logPrint(db, { modelId: MODEL })
    await addPhoto(db, { modelId: MODEL, printRunId: printId, ...picture('orphan') })

    await db.execute(sql`DELETE FROM print_runs WHERE id = ${printId}`)

    const photos = await listPhotos(db, MODEL)
    expect(photos).toHaveLength(1)
    expect(photos[0]!.printRunId).toBeNull()
  })

  it('lists the newest photo first', async () => {
    await addPhoto(db, { modelId: MODEL, caption: 'Older', ...picture('older') })
    await addPhoto(db, { modelId: MODEL, caption: 'Newer', ...picture('newer') })

    expect((await listPhotos(db, MODEL)).map((photo) => photo.caption)).toEqual(['Newer', 'Older'])
  })
})
