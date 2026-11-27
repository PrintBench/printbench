// @covers DEMO-001
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import pg from 'pg'
import {
  createStorageAdapter,
  demoUploadsPath,
  getSettings,
  resolveLibraryLocation,
  scanLibrary,
  type LibraryLocation,
} from '@pb/core'
import { createDb, schema } from '@pb/db'
import { demoNeedsReset, resetDemo, type DemoResetDeps } from './reset'

/**
 * The nightly reset, end to end, against the committed demo-library.
 *
 * In a scratch database of its own: a reset drops the whole schema, and the
 * database the rest of the suite shares is not a place to try that.
 */
const url = process.env.DATABASE_URL
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

describe('demo reset', { tags: ['integration'] }, () => {
  let admin: pg.Pool
  let scratch: ReturnType<typeof createDb>
  let work = ''
  const name = `pb_demo_test_${Date.now().toString(36)}`
  const pauseWork = vi.fn(async () => {})
  const resumeWork = vi.fn(async (_options: { restored: boolean }) => {})
  let deps: DemoResetDeps

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url, max: 1 })
    await admin.query(`CREATE DATABASE ${name}`)
    const target = new URL(url!)
    target.pathname = `/${name}`
    scratch = createDb(target.toString())

    work = await mkdtemp(path.join(tmpdir(), 'pb-demo-reset-'))
    vi.stubEnv('PRINTBENCH_DEMO', '1')
    vi.stubEnv('DATA_DIR', work)
    vi.stubEnv('MANAGED_LIBRARY_ROOT', '')
    vi.stubEnv('DEMO_LIBRARY_PATH', path.join(repoRoot, 'demo-library'))

    const { db, pool } = scratch
    deps = {
      db,
      pool,
      dataDir: work,
      pauseWork,
      resumeWork,
      // The real job reaches for the shared database and queue; this is the same scan, bound here.
      scan: async (libraryId) => {
        const [library] = await db
          .select()
          .from(schema.libraries)
          .where(eq(schema.libraries.id, libraryId))
        const location = await resolveLibraryLocation(db, library!)
        await scanLibrary(
          {
            db,
            storage: createStorageAdapter(location),
            library: { ...location, groupingMode: library!.groupingMode } as LibraryLocation,
          },
          { mode: 'deep' },
        )
      },
    }
  }, 60_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    await scratch?.pool.end()
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    await admin.end()
    await rm(work, { recursive: true, force: true })
  }, 60_000)

  const count = (table: Parameters<typeof scratch.db.$count>[0]) => scratch.db.$count(table)

  it('treats an empty database as needing a reset', async () => {
    expect(await demoNeedsReset(scratch.db)).toBe(true)
  })

  it('builds the shop window from nothing', async () => {
    const result = await resetDemo(deps, { paused: true })

    expect(pauseWork).not.toHaveBeenCalled()
    expect(resumeWork).toHaveBeenCalledWith({ restored: true })

    const users = await scratch.db.select().from(schema.user)
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({
      id: result.userId,
      email: 'demo@printbench.app',
      role: 'admin',
    })

    expect(await count(schema.libraries)).toBe(2)
    expect(await count(schema.models)).toBe(22)
    // Fifteen logged prints, plus the one that marking a queue request done records.
    expect(await count(schema.printRuns)).toBe(16)
    expect(await count(schema.printRequests)).toBe(6)

    // Sidecar metadata came through the scan, not the seed.
    const tagged = await scratch.db.execute<{ n: number }>(
      sql`SELECT count(DISTINCT model_id)::int AS n FROM model_tags`,
    )
    expect(tagged.rows[0]!.n).toBe(22)

    expect(await demoNeedsReset(scratch.db)).toBe(false)
  }, 120_000)

  it('throws away everything a visitor did, and their session', async () => {
    const { db } = scratch
    const [before] = await db.select().from(schema.user)
    await db.execute(sql`INSERT INTO tags (name, slug) VALUES ('graffiti', 'graffiti')`)
    await db.execute(sql`INSERT INTO settings (key, value) VALUES ('missingGraceDays', '3'::jsonb)`)
    await db.execute(sql`
      INSERT INTO session (id, token, expires_at, user_id)
      VALUES ('visitor', 'visitor-token', now() + interval '1 day', ${before!.id})`)
    await mkdir(demoUploadsPath(), { recursive: true })
    await writeFile(path.join(demoUploadsPath(), 'upload.stl'), 'solid x\nendsolid x\n')
    await mkdir(path.join(work, 'previews'), { recursive: true })
    await writeFile(path.join(work, 'previews', 'stale.webp'), 'x')

    pauseWork.mockClear()
    await resetDemo(deps)
    expect(pauseWork).toHaveBeenCalledOnce()

    const [after] = await db.select().from(schema.user)
    expect(after!.id).not.toBe(before!.id)
    expect(await count(schema.session)).toBe(0)
    const graffiti = await db.execute(sql`SELECT 1 FROM tags WHERE slug = 'graffiti'`)
    expect(graffiti.rows).toHaveLength(0)
    expect((await getSettings(db)).missingGraceDays).toBe(30)
    expect(await readdir(demoUploadsPath())).toEqual([])
    expect(await readdir(path.join(work, 'previews'))).toEqual([])
    expect(await count(schema.models)).toBe(22)
  }, 120_000)
})
