import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDb } from '@pb/db'
import { watchTargets } from './watcher'

/**
 * Which libraries the database wants watched.
 *
 * Kept separate from reconcileWatches(), which actually starts and stops
 * chokidar instances — real filesystem watching belongs in manual
 * verification, not a test that has to wait on OS file events to pass
 * reliably in CI. This is the part that decides WHAT to watch, and it is
 * plain SQL with no side effects, so it can be asserted directly.
 */
const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

const LOCAL_ON = '7900e000-0000-4000-8000-000000000001'
const LOCAL_OFF = '7900e000-0000-4000-8000-000000000002'
const S3_ON = '7900e000-0000-4000-8000-000000000003'

describeDb('watchTargets', () => {
  let pool: ReturnType<typeof createDb>['pool']
  let db: ReturnType<typeof createDb>['db']

  beforeAll(() => {
    ;({ pool, db } = createDb())
  })

  afterAll(async () => {
    await cleanup()
    await pool.end()
  })

  beforeEach(async () => {
    await cleanup()
    await db.execute(sql`
      INSERT INTO libraries (id, name, kind, backend, path, watch_enabled) VALUES
        (${LOCAL_ON}, 'Watched', 'in_place', 'local', '/libraries/watched', true),
        (${LOCAL_OFF}, 'Not watched', 'in_place', 'local', '/libraries/quiet', false)
    `)
    await db.execute(sql`
      INSERT INTO libraries (id, name, kind, backend, s3_bucket, watch_enabled) VALUES
        (${S3_ON}, 'S3 watched (should be ignored)', 'in_place', 's3', 'bucket', true)
    `)
  })

  async function cleanup() {
    await db.execute(sql`DELETE FROM libraries WHERE id IN (${LOCAL_ON}, ${LOCAL_OFF}, ${S3_ON})`)
  }

  it('includes a local library with watching turned on', async () => {
    const targets = await watchTargets()
    expect(targets.map((t) => t.id)).toContain(LOCAL_ON)
  })

  it('excludes a local library with watching turned off', async () => {
    const targets = await watchTargets()
    expect(targets.map((t) => t.id)).not.toContain(LOCAL_OFF)
  })

  /*
   * There is no filesystem to hand to chokidar for an S3 library, however the
   * toggle is set — this is the check that keeps that from ever being tried.
   */
  it('excludes an S3 library even with watching turned on', async () => {
    const targets = await watchTargets()
    expect(targets.map((t) => t.id)).not.toContain(S3_ON)
  })

  it('carries the path and name through', async () => {
    const targets = await watchTargets()
    const target = targets.find((t) => t.id === LOCAL_ON)
    expect(target?.path).toBe('/libraries/watched')
    expect(target?.name).toBe('Watched')
  })
})
