import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDb } from '@pm/db'
import { pendingDeletions, prune } from './prune-service'

/**
 * The only code in this project that destroys metadata.
 *
 * So the tests are mostly about what it refuses to do. The scenario that
 * matters is a NAS unplugged for two months: every model in that library is
 * missing and past the grace period, and deleting them would throw away
 * exactly what the sidecars exist to protect.
 */
const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

const LIVE_LIB = '99000000-0000-4000-8000-000000000001'
const DEAD_LIB = '99000000-0000-4000-8000-000000000002'
const id = (suffix: string) => `99aa0000-0000-4000-8000-0000000000${suffix}`

describeDb('prune', () => {
  let pool: ReturnType<typeof createDb>['pool']
  let db: ReturnType<typeof createDb>['db']

  const exists = async (suffix: string): Promise<boolean> => {
    const rows = await db.execute<{ count: number }>(
      sql`SELECT count(*)::int FROM models WHERE id = ${id(suffix)}`,
    )
    return (rows.rows[0]?.count ?? 0) > 0
  }

  beforeAll(() => {
    ;({ pool, db } = createDb())
  })

  afterAll(async () => {
    await cleanup()
    await pool.end()
  })

  beforeEach(async () => {
    await cleanup()
    await seed()
  })

  async function cleanup() {
    await db.execute(sql`DELETE FROM libraries WHERE id IN (${LIVE_LIB}, ${DEAD_LIB})`)
  }

  async function seed() {
    await db.execute(sql`
      INSERT INTO libraries (id, name, kind, backend, path) VALUES
        (${LIVE_LIB}, 'Live Library', 'in_place', 'local', '/fixtures/live'),
        (${DEAD_LIB}, 'Unplugged NAS', 'in_place', 'local', '/mnt/nas')`)

    // suffix, library, name, missingDaysAgo (null = present)
    const models: [string, string, string, number | null][] = [
      ['01', LIVE_LIB, 'Present Model', null],
      ['02', LIVE_LIB, 'Missing Yesterday', 1],
      ['04', LIVE_LIB, 'Missing Just Now', 0],
      ['03', LIVE_LIB, 'Missing Ages Ago', 90],
      // Every model in this library is missing — the unplugged-drive signature.
      ['10', DEAD_LIB, 'NAS Model One', 60],
      ['11', DEAD_LIB, 'NAS Model Two', 60],
    ]

    for (const [suffix, library, name, days] of models) {
      await db.execute(sql`
        INSERT INTO models (id, library_id, path, name, slug, public_id, file_count, total_size,
                            missing_at)
        VALUES (${id(suffix)}, ${library}, ${'pr/' + suffix}, ${name}, ${'pr-' + suffix},
                ${'mdpr0000000' + suffix}, 1, 1000,
                ${days === null ? null : sql`now() - ${`${days} days`}::interval`})`)
    }

    await db.execute(sql`
      INSERT INTO model_files (model_id, filename, extension, category, media_type, size, missing_at)
      VALUES (${id('01')}, 'gone.stl', 'stl', 'model', 'model/stl', 100,
              now() - '90 days'::interval)`)
  }

  it('removes a model missing longer than the grace period', async () => {
    const result = await prune(db, { graceDays: 30 })

    expect(await exists('03')).toBe(false)
    expect(result.modelsDeleted).toBeGreaterThan(0)
  })

  it('keeps a model still within the grace period', async () => {
    await prune(db, { graceDays: 30 })
    expect(await exists('02')).toBe(true)
  })

  it('never touches a model that is present', async () => {
    await prune(db, { graceDays: 1 })
    expect(await exists('01')).toBe(true)
  })

  /*
   * The important one. A library where nothing is present is an unmounted
   * drive, not a deleted collection — and no grace period makes it safe to act
   * on that.
   */
  it('refuses to prune a library where everything is missing', async () => {
    const result = await prune(db, { graceDays: 1 })

    expect(await exists('10')).toBe(true)
    expect(await exists('11')).toBe(true)
    expect(result.librariesSkipped).toContain('Unplugged NAS')
  })

  it('still prunes healthy libraries while skipping a suspect one', async () => {
    await prune(db, { graceDays: 30 })

    expect(await exists('03')).toBe(false) // live library, long gone
    expect(await exists('10')).toBe(true) // suspect library, untouched
  })

  it('removes a file that vanished from a model still present', async () => {
    await prune(db, { graceDays: 30 })

    const rows = await db.execute<{ count: number }>(sql`
      SELECT count(*)::int FROM model_files WHERE model_id = ${id('01')}`)
    expect(rows.rows[0]!.count).toBe(0)
    // The model itself is present and must survive.
    expect(await exists('01')).toBe(true)
  })

  /*
   * A grace period of zero would delete a model the instant a scan first failed
   * to see it — which is precisely the unmounted-drive case. The clamp means the
   * worst a bad setting can do is one day.
   */
  it('treats a grace period below one day as one day', async () => {
    await prune(db, { graceDays: 0 })
    expect(await exists('04')).toBe(true)

    await prune(db, { graceDays: -10 })
    expect(await exists('04')).toBe(true)
  })

  it('reports without deleting on a dry run', async () => {
    const result = await prune(db, { graceDays: 30, dryRun: true })

    expect(result.modelsDeleted).toBeGreaterThan(0)
    expect(await exists('03')).toBe(true)
  })

  it('is safe to run twice', async () => {
    await prune(db, { graceDays: 30 })
    const second = await prune(db, { graceDays: 30 })
    expect(second.modelsDeleted).toBe(0)
  })

  describe('pendingDeletions', () => {
    it('counts down to removal', async () => {
      const pending = await pendingDeletions(db, 30)
      const soon = pending.find((row) => row.name === 'Missing Yesterday')

      expect(soon).toBeTruthy()
      expect(soon!.daysLeft).toBeGreaterThan(25)
      expect(soon!.daysLeft).toBeLessThanOrEqual(30)
    })

    it('reports zero days left for something already past the period', async () => {
      const pending = await pendingDeletions(db, 30)
      expect(pending.find((row) => row.name === 'Missing Ages Ago')!.daysLeft).toBe(0)
    })

    it('lists the longest-missing first', async () => {
      const pending = await pendingDeletions(db, 30)
      const names = pending.map((row) => row.name)
      expect(names.indexOf('Missing Ages Ago')).toBeLessThan(names.indexOf('Missing Yesterday'))
    })
  })
})
