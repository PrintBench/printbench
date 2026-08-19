import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { createDb } from '@pm/db'
import { LocalAdapter } from '../storage/local-adapter'
import type { LibraryLocation } from '../storage/types'
import { MASS_DISAPPEARANCE_THRESHOLD, scanLibrary } from './scan-service'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

const LIBRARY_ID = '0f0f0f0f-0000-4000-8000-00000000scan'.replace('scan', 'a001')

describeDb('scanLibrary', () => {
  let pool: ReturnType<typeof createDb>['pool']
  let db: ReturnType<typeof createDb>['db']
  let root: string
  let library: LibraryLocation

  const storage = () => new LocalAdapter(library)
  const scan = (options = {}) =>
    scanLibrary({ db, storage: storage(), library }, { mode: 'deep', ...options })

  async function liveModels(): Promise<{ path: string; name: string; fileCount: number }[]> {
    const result = await db.execute<{ path: string; name: string; file_count: number }>(sql`
      SELECT path, name, file_count FROM models
      WHERE library_id = ${LIBRARY_ID} AND missing_at IS NULL
      ORDER BY path
    `)
    return result.rows.map((r) => ({ path: r.path, name: r.name, fileCount: r.file_count }))
  }

  async function missingModelCount(): Promise<number> {
    const result = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM models
      WHERE library_id = ${LIBRARY_ID} AND missing_at IS NOT NULL
    `)
    return result.rows[0]?.n ?? 0
  }

  /** Builds the standard fixture library from scratch. */
  async function buildFixture(): Promise<void> {
    await rm(root, { recursive: true, force: true })
    await mkdir(path.join(root, 'Dragons', 'Red Dragon', 'stl'), { recursive: true })
    await mkdir(path.join(root, 'Dragons', 'Red Dragon', 'images'), { recursive: true })
    await mkdir(path.join(root, 'Dragons', 'Blue Dragon'), { recursive: true })
    await mkdir(path.join(root, 'Terrain', 'Bridge'), { recursive: true })
    await mkdir(path.join(root, 'Terrain', 'Tower'), { recursive: true })
    await mkdir(path.join(root, 'Boxes'), { recursive: true })

    await writeFile(path.join(root, 'Dragons', 'Red Dragon', 'stl', 'body.stl'), 'x'.repeat(120))
    await writeFile(path.join(root, 'Dragons', 'Red Dragon', 'images', 'preview.png'), 'p')
    await writeFile(path.join(root, 'Dragons', 'Blue Dragon', 'blue.stl'), 'y'.repeat(60))
    await writeFile(path.join(root, 'Terrain', 'Bridge', 'bridge.stl'), 'b')
    await writeFile(path.join(root, 'Terrain', 'Tower', 'tower.stl'), 't')
    await writeFile(path.join(root, 'Boxes', 'box.3mf'), 'z')
    await writeFile(path.join(root, 'benchy.stl'), 'w')
  }

  beforeAll(async () => {
    ;({ pool, db } = createDb(url))
  })

  beforeEach(async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'pm-scan-'))
    root = path.join(base, 'library')
    library = {
      id: LIBRARY_ID,
      kind: 'in_place',
      backend: 'local',
      allowWrites: false,
      path: root,
    }
    await buildFixture()

    await db.execute(sql`DELETE FROM libraries WHERE id = ${LIBRARY_ID}`)
    await db.execute(sql`
      INSERT INTO libraries (id, name, kind, backend, path)
      VALUES (${LIBRARY_ID}, 'Scan Fixture', 'in_place', 'local', ${root})
    `)
  })

  afterEach(async () => {
    await db.execute(sql`DELETE FROM libraries WHERE id = ${LIBRARY_ID}`)
    await rm(path.dirname(root), { recursive: true, force: true })
  })

  afterAll(async () => {
    await pool.end()
  })

  describe('first scan', () => {
    it('indexes the models a human would expect', async () => {
      const outcome = await scan()

      expect(outcome.status).toBe('succeeded')
      expect(await liveModels()).toEqual([
        { path: 'Boxes', name: 'Boxes', fileCount: 1 },
        { path: 'Dragons/Blue Dragon', name: 'Blue Dragon', fileCount: 1 },
        { path: 'Dragons/Red Dragon', name: 'Red Dragon', fileCount: 2 },
        { path: 'Terrain/Bridge', name: 'Bridge', fileCount: 1 },
        { path: 'Terrain/Tower', name: 'Tower', fileCount: 1 },
        { path: 'benchy.stl', name: 'Benchy', fileCount: 1 },
      ])
      expect(outcome.modelsCreated).toBe(6)
      expect(outcome.modelsMissing).toBe(0)
    })

    it('records file metadata and picks a preview', async () => {
      await scan()
      const files = await db.execute<{
        filename: string
        category: string
        previewable: boolean
        presupported: boolean
      }>(sql`
        SELECT f.filename, f.category, f.previewable, f.presupported
        FROM model_files f JOIN models m ON m.id = f.model_id
        WHERE m.path = 'Dragons/Red Dragon' ORDER BY f.filename
      `)
      expect(files.rows.map((r) => r.filename)).toEqual(['images/preview.png', 'stl/body.stl'])
      expect(files.rows.find((r) => r.filename === 'stl/body.stl')?.previewable).toBe(true)

      // An image named "preview" beats the mesh as the grid thumbnail.
      const preview = await db.execute<{ filename: string }>(sql`
        SELECT f.filename FROM models m JOIN model_files f ON f.id = m.preview_file_id
        WHERE m.path = 'Dragons/Red Dragon'
      `)
      expect(preview.rows[0]?.filename).toBe('images/preview.png')
    })

    /*
     * Regression: file size and mtime were collected by the walker but dropped
     * by the grouping step, so every model reported a total size of 0 B — and
     * the digest step had no way to tell whether a file had changed.
     */
    it('records real file sizes and mtimes', async () => {
      await scan()
      const files = await db.execute<{ filename: string; size: string; mtime_ms: string }>(sql`
        SELECT f.filename, f.size, f.mtime_ms FROM model_files f
        JOIN models m ON m.id = f.model_id
        WHERE m.path = 'Dragons/Red Dragon' AND m.library_id = ${LIBRARY_ID}
        ORDER BY f.filename
      `)
      const body = files.rows.find((r) => r.filename === 'stl/body.stl')
      expect(Number(body?.size)).toBe(120)
      expect(Number(body?.mtime_ms)).toBeGreaterThan(0)

      const model = await db.execute<{ total_size: string }>(sql`
        SELECT total_size FROM models WHERE path = 'Dragons/Red Dragon' AND library_id = ${LIBRARY_ID}
      `)
      expect(Number(model.rows[0]?.total_size)).toBeGreaterThan(0)
    })

    it('creates a scan_run recording what happened', async () => {
      const outcome = await scan()
      const run = await db.execute<{ status: string; models_created: number; dirs_walked: number }>(sql`
        SELECT status, models_created, dirs_walked FROM scan_runs WHERE id = ${outcome.scanRunId}
      `)
      expect(run.rows[0]?.status).toBe('succeeded')
      expect(run.rows[0]?.models_created).toBe(6)
      expect(run.rows[0]?.dirs_walked).toBeGreaterThan(0)
    })

    it('makes models findable by search immediately', async () => {
      await scan()
      const found = await db.execute<{ name: string }>(sql`
        SELECT name FROM models
        WHERE library_id = ${LIBRARY_ID}
          AND search_vector @@ websearch_to_tsquery('pm_search', 'dragon')
        ORDER BY name
      `)
      expect(found.rows.map((r) => r.name)).toEqual(['Blue Dragon', 'Red Dragon'])
    })
  })

  describe('idempotency', () => {
    it('a rescan of an unchanged library changes nothing', async () => {
      const first = await scan()
      const before = await liveModels()

      const second = await scan()

      expect(second.modelsCreated).toBe(0)
      expect(second.modelsMissing).toBe(0)
      expect(second.filesCreated).toBe(0)
      expect(await liveModels()).toEqual(before)
      expect(second.scanRunId).not.toBe(first.scanRunId)
    })

    it('keeps stable model ids across rescans, so metadata survives', async () => {
      await scan()
      const before = await db.execute<{ id: string }>(
        sql`SELECT id FROM models WHERE path = 'Dragons/Red Dragon' AND library_id = ${LIBRARY_ID}`,
      )
      await scan()
      const after = await db.execute<{ id: string }>(
        sql`SELECT id FROM models WHERE path = 'Dragons/Red Dragon' AND library_id = ${LIBRARY_ID}`,
      )
      expect(after.rows[0]?.id).toBe(before.rows[0]?.id)
    })

    it('never overwrites user edits to a model', async () => {
      await scan()
      await db.execute(sql`
        UPDATE models SET name = 'My Custom Name', notes = 'hand written'
        WHERE path = 'Dragons/Red Dragon' AND library_id = ${LIBRARY_ID}
      `)

      await scan()

      const row = await db.execute<{ name: string; notes: string }>(sql`
        SELECT name, notes FROM models WHERE path = 'Dragons/Red Dragon' AND library_id = ${LIBRARY_ID}
      `)
      expect(row.rows[0]?.name).toBe('My Custom Name')
      expect(row.rows[0]?.notes).toBe('hand written')
    })
  })

  describe('incremental changes', () => {
    it('picks up a newly added model', async () => {
      await scan()
      await mkdir(path.join(root, 'Dragons', 'Green Dragon'), { recursive: true })
      await writeFile(path.join(root, 'Dragons', 'Green Dragon', 'green.stl'), 'g')

      const outcome = await scan()

      expect(outcome.modelsCreated).toBe(1)
      expect((await liveModels()).map((m) => m.path)).toContain('Dragons/Green Dragon')
    })

    it('marks derived data stale when a file changes on disk', async () => {
      await scan()
      await db.execute(sql`
        UPDATE model_files SET digest = 'stale-digest', analysis_state = 'ok', thumb_state = 'ok'
        FROM models m WHERE m.id = model_files.model_id
          AND m.path = 'Dragons/Blue Dragon' AND m.library_id = ${LIBRARY_ID}
      `)

      // Rewrite the file with different contents and a different length.
      await writeFile(path.join(root, 'Dragons', 'Blue Dragon', 'blue.stl'), 'y'.repeat(999))
      await scan()

      const file = await db.execute<{ digest: string | null; analysis_state: string; size: string }>(sql`
        SELECT f.digest, f.analysis_state, f.size FROM model_files f
        JOIN models m ON m.id = f.model_id
        WHERE m.path = 'Dragons/Blue Dragon' AND m.library_id = ${LIBRARY_ID}
      `)
      expect(Number(file.rows[0]?.size)).toBe(999)
      // Anything derived from the old bytes must be recomputed, not trusted.
      expect(file.rows[0]?.digest).toBeNull()
      expect(file.rows[0]?.analysis_state).toBe('pending')
    })

    it('picks up a file added to an existing model', async () => {
      await scan()
      await writeFile(path.join(root, 'Dragons', 'Blue Dragon', 'wings.stl'), 'w')

      const outcome = await scan()

      expect(outcome.filesCreated).toBe(1)
      const blue = (await liveModels()).find((m) => m.path === 'Dragons/Blue Dragon')
      expect(blue?.fileCount).toBe(2)
    })

    it('soft-deletes a removed model rather than destroying it', async () => {
      await scan()
      await rm(path.join(root, 'Boxes'), { recursive: true, force: true })

      const outcome = await scan()

      expect(outcome.modelsMissing).toBe(1)
      expect((await liveModels()).map((m) => m.path)).not.toContain('Boxes')
      // The row survives with its tags and history, pending the grace period.
      expect(await missingModelCount()).toBe(1)
    })

    it('revives a model that comes back', async () => {
      await scan()
      const originalId = (
        await db.execute<{ id: string }>(
          sql`SELECT id FROM models WHERE path = 'Boxes' AND library_id = ${LIBRARY_ID}`,
        )
      ).rows[0]?.id

      await rm(path.join(root, 'Boxes'), { recursive: true, force: true })
      await scan()
      expect(await missingModelCount()).toBe(1)

      await mkdir(path.join(root, 'Boxes'), { recursive: true })
      await writeFile(path.join(root, 'Boxes', 'box.3mf'), 'z')
      await scan()

      expect(await missingModelCount()).toBe(0)
      const revived = await db.execute<{ id: string }>(
        sql`SELECT id FROM models WHERE path = 'Boxes' AND library_id = ${LIBRARY_ID}`,
      )
      // Same row, so anything the user attached to it is intact.
      expect(revived.rows[0]?.id).toBe(originalId)
    })
  })

  describe('safety guards', () => {
    it('aborts when the library root has vanished', async () => {
      await scan()
      await rm(root, { recursive: true, force: true })

      const outcome = await scan()

      expect(outcome.status).toBe('aborted')
      expect(outcome.abortReason).toBe('storage_unavailable')
      // Crucially: nothing was marked missing.
      expect(await missingModelCount()).toBe(0)
      expect(await liveModels()).toHaveLength(6)
    })

    it('aborts when the root is empty but models are on record', async () => {
      await scan()
      // The unmounted-NAS signature: directory present, contents gone.
      for (const entry of ['Dragons', 'Terrain', 'Boxes']) {
        await rm(path.join(root, entry), { recursive: true, force: true })
      }
      await rm(path.join(root, 'benchy.stl'), { force: true })

      const outcome = await scan()

      expect(outcome.status).toBe('aborted')
      expect(outcome.abortReason).toBe('empty_root')
      expect(outcome.abortDetail).toMatch(/not mounted/i)
      expect(await missingModelCount()).toBe(0)
      expect(await liveModels()).toHaveLength(6)
    })

    it('aborts when too much of the library would disappear at once', async () => {
      await scan()
      // Remove 4 of 6 models (67%), far past the 20% threshold.
      await rm(path.join(root, 'Dragons'), { recursive: true, force: true })
      await rm(path.join(root, 'Terrain'), { recursive: true, force: true })

      const outcome = await scan()

      expect(outcome.status).toBe('aborted')
      expect(outcome.abortReason).toBe('mass_disappearance')
      expect(outcome.abortDetail).toMatch(/4 of 6/)
      expect(await missingModelCount()).toBe(0)
      expect(await liveModels()).toHaveLength(6)
    })

    it('records the abort reason on the scan run for the UI to show', async () => {
      await scan()
      await rm(path.join(root, 'Dragons'), { recursive: true, force: true })
      await rm(path.join(root, 'Terrain'), { recursive: true, force: true })
      const outcome = await scan()

      const run = await db.execute<{ status: string; abort_reason: string }>(
        sql`SELECT status, abort_reason FROM scan_runs WHERE id = ${outcome.scanRunId}`,
      )
      expect(run.rows[0]?.status).toBe('aborted')
      expect(run.rows[0]?.abort_reason).toBe('mass_disappearance')
    })

    it('proceeds when an admin confirms the deletion was genuine', async () => {
      await scan()
      await rm(path.join(root, 'Dragons'), { recursive: true, force: true })
      await rm(path.join(root, 'Terrain'), { recursive: true, force: true })

      const outcome = await scan({ force: true })

      expect(outcome.status).toBe('succeeded')
      expect(outcome.modelsMissing).toBe(4)
      expect(await liveModels()).toHaveLength(2)
    })

    it('allows a small deletion without confirmation', async () => {
      await scan()
      // 1 of 6 is under the threshold — ordinary tidying, not a mount failure.
      await rm(path.join(root, 'Boxes'), { recursive: true, force: true })

      const outcome = await scan()

      expect(outcome.status).toBe('succeeded')
      expect(outcome.modelsMissing).toBe(1)
    })

    it('does not apply the proportional guard to a tiny library', async () => {
      // Fresh, near-empty library: deleting the only model is not suspicious.
      await rm(root, { recursive: true, force: true })
      await mkdir(path.join(root, 'Only'), { recursive: true })
      await writeFile(path.join(root, 'Only', 'a.stl'), 'a')
      await scan()

      await rm(path.join(root, 'Only'), { recursive: true, force: true })
      await writeFile(path.join(root, 'placeholder.stl'), 'p')
      const outcome = await scan()

      expect(outcome.status).toBe('succeeded')
    })

    it('threshold is the documented value', () => {
      expect(MASS_DISAPPEARANCE_THRESHOLD).toBe(0.2)
    })
  })

  describe('fast scan', () => {
    it('finds a new model added below an unchanged parent', async () => {
      await scan({ mode: 'deep' })

      // Parent "Dragons" keeps its mtime; only the new directory changes.
      await mkdir(path.join(root, 'Dragons', 'Green Dragon'), { recursive: true })
      await writeFile(path.join(root, 'Dragons', 'Green Dragon', 'green.stl'), 'g')

      const outcome = await scan({ mode: 'fast' })

      expect(outcome.status).toBe('succeeded')
      expect((await liveModels()).map((m) => m.path)).toContain('Dragons/Green Dragon')
    })

    it('does not lose models it skipped re-examining', async () => {
      await scan({ mode: 'deep' })
      const outcome = await scan({ mode: 'fast' })

      expect(outcome.status).toBe('succeeded')
      expect(outcome.modelsMissing).toBe(0)
      expect(await liveModels()).toHaveLength(6)
    })
  })
})
