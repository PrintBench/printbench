import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDb } from '@pb/db'
import { modelPreviewStatuses } from './preview-status'

const LIBRARY = 'a8480000-0000-4000-8000-000000000001'
const MODEL = 'a8480000-0000-4000-8000-000000000002'
const MESH = 'a8480000-0000-4000-8000-000000000003'
const IMAGE = 'a8480000-0000-4000-8000-000000000004'
const OTHER = 'a8480000-0000-4000-8000-000000000005'
const PUBLIC_ID = 'preview-status-fixture'

describe.skipIf(!process.env.DATABASE_URL)('modelPreviewStatuses', () => {
  let db: ReturnType<typeof createDb>['db']
  let pool: ReturnType<typeof createDb>['pool']
  beforeAll(() => {
    ;({ db, pool } = createDb())
  })
  beforeEach(async () => {
    await db.execute(sql`DELETE FROM libraries WHERE id = ${LIBRARY}`)
    await db.execute(sql`INSERT INTO libraries (id, name, kind, backend, path)
      VALUES (${LIBRARY}, 'Preview fixture', 'managed', 'local', '/fixtures/previews')`)
    await db.execute(sql`INSERT INTO models (id, library_id, path, name, slug, public_id)
      VALUES (${MODEL}, ${LIBRARY}, 'model', 'Model', 'preview-fixture', ${PUBLIC_ID})`)
    await db.execute(sql`INSERT INTO model_files (id, model_id, filename, extension, category, previewable)
      VALUES (${MESH}, ${MODEL}, 'model.stl', 'stl', 'model', true)`)
    await db.execute(sql`UPDATE models SET preview_file_id = ${MESH} WHERE id = ${MODEL}`)
  })
  afterAll(async () => {
    await db.execute(sql`DELETE FROM libraries WHERE id = ${LIBRARY}`)
    await pool.end()
  })
  const read = async () => (await modelPreviewStatuses(db, [PUBLIC_ID]))[0]!

  it('changes from processing to a versioned thumbnail as the worker completes', async () => {
    expect(await read()).toMatchObject({ state: 'pending', thumbFileId: null })
    await db.execute(
      sql`UPDATE model_files SET thumb_state = 'ok', thumb_key = 'render-key' WHERE id = ${MESH}`,
    )
    expect(await read()).toMatchObject({
      state: 'ready',
      thumbFileId: MESH,
      thumbKey: 'render-key',
    })
  })

  it('keeps creator artwork authoritative before and after mesh processing', async () => {
    await db.execute(sql`INSERT INTO model_files (id, model_id, filename, extension, category)
      VALUES (${IMAGE}, ${MODEL}, 'cover.png', 'png', 'image')`)
    await db.execute(sql`UPDATE models SET preview_file_id = ${IMAGE} WHERE id = ${MODEL}`)
    expect(await read()).toMatchObject({
      state: 'ready',
      previewImageFileId: IMAGE,
      thumbFileId: null,
    })
    await db.execute(
      sql`UPDATE model_files SET thumb_state = 'ok', thumb_key = 'render-key' WHERE id = ${MESH}`,
    )
    expect(await read()).toMatchObject({
      state: 'ready',
      previewImageFileId: IMAGE,
      thumbFileId: MESH,
    })
    const selected = await db.execute<{ preview_file_id: string }>(
      sql`SELECT preview_file_id FROM models WHERE id = ${MODEL}`,
    )
    expect(selected.rows[0]?.preview_file_id).toBe(IMAGE)
  })

  it.each(['failed', 'skipped'] as const)(
    'stops processing when rendering is %s',
    async (state) => {
      await db.execute(sql`UPDATE model_files SET thumb_state = ${state} WHERE id = ${MESH}`)
      expect(await read()).toMatchObject({ state: 'unavailable', thumbFileId: null })
    },
  )

  it('does not mistake an unsupported file with the default pending state for processing', async () => {
    await db.execute(
      sql`UPDATE model_files SET previewable = false, extension = 'step' WHERE id = ${MESH}`,
    )
    expect(await read()).toMatchObject({ state: 'unavailable' })
  })

  it('shows a ready fallback even if another file is still pending', async () => {
    await db.execute(sql`INSERT INTO model_files (id, model_id, filename, extension, category, previewable, thumb_state, thumb_key, size)
      VALUES (${OTHER}, ${MODEL}, 'other.stl', 'stl', 'model', true, 'ok', 'other-key', 100)`)
    expect(await read()).toMatchObject({ state: 'ready', thumbFileId: OTHER })
    await db.execute(
      sql`UPDATE model_files SET thumb_state = 'ok', thumb_key = 'selected-key' WHERE id = ${MESH}`,
    )
    expect(await read()).toMatchObject({ state: 'ready', thumbFileId: MESH })
  })

  it('ignores missing files and omits missing or unknown models', async () => {
    await db.execute(sql`UPDATE model_files SET missing_at = now() WHERE id = ${MESH}`)
    expect(await read()).toMatchObject({ state: 'unavailable' })
    await db.execute(sql`UPDATE models SET missing_at = now() WHERE id = ${MODEL}`)
    expect(await modelPreviewStatuses(db, [PUBLIC_ID, 'unknown'])).toEqual([])
  })

  it('deduplicates IDs and bounds batches', async () => {
    expect(await modelPreviewStatuses(db, [])).toEqual([])
    expect(await modelPreviewStatuses(db, [PUBLIC_ID, PUBLIC_ID])).toHaveLength(1)
    await expect(
      modelPreviewStatuses(
        db,
        Array.from({ length: 201 }, (_, i) => `id-${i}`),
      ),
    ).rejects.toThrow('Too many')
  })
})
