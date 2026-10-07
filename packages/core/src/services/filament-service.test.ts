import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDb } from '@pb/db'
import {
  archiveFilament,
  archiveSpool,
  createSpool,
  editFilament,
  editSpool,
  getPrintUsage,
  listSpools,
  measureSpool,
  spoolHistory,
  spoolPrints,
  remainingFromMeasurement,
  combineUsage,
} from './filament-service'
import { deletePrint, listPrints, logPrint, updatePrint } from './print-service'
import { exportFilamentInventory, restoreFilamentInventory } from './filament-backup'
import { setRequestStatus } from './request-service'
import { can } from '../policy/policy'

const url = process.env.DATABASE_URL
const LIB = 'fa000000-0000-4000-8000-000000000001'
const MODEL = 'fa000000-0000-4000-8000-000000000002'
const REQUEST = 'fa000000-0000-4000-8000-000000000003'

describe('filament input and permissions', () => {
  it('subtracts tare and rejects invalid weights', () => {
    expect(remainingFromMeasurement(620.25, 190)).toBe(430.25)
    expect(() => remainingFromMeasurement(10, 20)).toThrow('Remaining filament')
    expect(() => remainingFromMeasurement(NaN, 20)).toThrow()
    expect(() => remainingFromMeasurement(Infinity, 20)).toThrow()
  })
  it('combines repeat selections without losing decimals', () => {
    expect(
      combineUsage([
        { spoolId: LIB, grams: 0.1 },
        { spoolId: LIB, grams: 0.2 },
      ]),
    ).toEqual([{ spoolId: LIB, grams: 0.3 }])
    expect(() => combineUsage([{ spoolId: LIB, grams: -1 }])).toThrow()
    expect(() => combineUsage([{ spoolId: 'bad', grams: 1 }])).toThrow()
  })
  it('allows shared browsing and member management', () => {
    expect(can({ id: 'v', role: 'viewer' }, 'filament:view')).toBe(true)
    expect(can({ id: 'v', role: 'viewer' }, 'filament:manage')).toBe(false)
    expect(can({ id: 'm', role: 'member' }, 'filament:manage')).toBe(true)
    expect(can({ id: 'a', role: 'admin', banned: true }, 'filament:view')).toBe(false)
    expect(can(null, 'filament:view')).toBe(false)
  })
})

describe.skipIf(!url)('filament inventory with Postgres', () => {
  let db: ReturnType<typeof createDb>['db']
  let pool: ReturnType<typeof createDb>['pool']
  let ids: string[] = []
  let filamentIds: string[] = []
  async function add(input: Parameters<typeof createSpool>[1] = {}) {
    const id = await createSpool(db, {
      filament: {
        name: 'Fixture PETG',
        material: 'PETG',
        brand: 'Test',
        colorName: 'Black',
        colorHex: '#222222',
        nozzleTempC: 240,
        bedTempC: 80,
      },
      purchaseCost: 20,
      ...input,
    })
    ids.push(id)
    const spool = (await listSpools(db)).find((s) => s.id === id)!
    filamentIds.push(spool.filamentId)
    return spool
  }
  async function balance(id: string) {
    return (await listSpools(db)).find((s) => s.id === id)!.remainingG
  }
  async function cleanup() {
    await db.execute(sql`DELETE FROM print_requests WHERE id = ${REQUEST}`)
    await db.execute(sql`DELETE FROM print_runs WHERE model_id = ${MODEL}`)
    for (const id of ids) {
      await db.execute(sql`DELETE FROM filament_stock_changes WHERE spool_id = ${id}`)
      await db.execute(sql`DELETE FROM print_filament_usage WHERE spool_id = ${id}`)
      await db.execute(sql`DELETE FROM filament_spools WHERE id = ${id}`)
    }
    for (const id of new Set(filamentIds))
      await db.execute(sql`DELETE FROM filaments WHERE id = ${id}`)
    ids = []
    filamentIds = []
  }
  beforeAll(async () => {
    ;({ db, pool } = createDb(url))
    await db.execute(sql`DELETE FROM libraries WHERE id = ${LIB}`)
    await db.execute(
      sql`INSERT INTO libraries (id, name, kind, backend, path) VALUES (${LIB}, 'Filament Fixture', 'in_place', 'local', '/fixtures/filament')`,
    )
    await db.execute(
      sql`INSERT INTO models (id, library_id, path, name, slug, public_id, file_count, total_size) VALUES (${MODEL}, ${LIB}, 'filament', 'Test cube', 'filament-test', 'mdfilament01', 1, 100)`,
    )
  })
  beforeEach(cleanup)
  afterAll(async () => {
    await cleanup()
    await db.execute(sql`DELETE FROM libraries WHERE id = ${LIB}`)
    await pool.end()
  })
  it('starts partial spools, reuses specifications, and duplicates independently', async () => {
    const a = await add({ remainingG: 430, label: 'Roll 1', location: 'Dry box' })
    const b = await add({
      filament: undefined,
      filamentId: a.filamentId,
      remainingG: 1000,
      label: 'Roll 2',
    })
    expect(a.remainingG).toBe(430)
    expect(b.remainingG).toBe(1000)
    expect(b.lowStockG).toBe(100)
    expect(b.filamentId).toBe(a.filamentId)
    await measureSpool(db, a.id, 100, 'Measured')
    expect(await balance(b.id)).toBe(1000)
    const history = await spoolHistory(db, a.id)
    expect(history.map((h) => h.kind)).toContain('correction')
    expect(history.find((h) => h.kind === 'correction')!.amount_g).toBe(-330)
  })
  it('rejects invalid spool weights without leaving a new filament', async () => {
    await expect(
      createSpool(db, {
        filament: { name: 'Invalid fixture', material: 'PLA' },
        nominalWeightG: 0.001,
      }),
    ).rejects.toThrow('0.01')
    const result = await db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM filaments WHERE name = 'Invalid fixture'`,
    )
    expect(result.rows[0]!.count).toBe(0)
  })
  it('keeps explicitly entered temperatures on a status-only edit', async () => {
    const a = await add()
    const { id } = await logPrint(db, {
      modelId: MODEL,
      nozzleTempC: 260,
      bedTempC: 90,
      filamentUsage: [{ spoolId: a.id, grams: 10 }],
    })
    await updatePrint(db, id, { status: 'partial' })
    const [print] = await listPrints(db, { modelId: MODEL })
    expect(print!.nozzleTempC).toBe(260)
    expect(print!.bedTempC).toBe(90)
  })
  it('records multiple spools, snapshots and automatic cost', async () => {
    const a = await add()
    const b = await add({ purchaseCost: 30 })
    const { id } = await logPrint(db, {
      modelId: MODEL,
      filamentUsage: [
        { spoolId: a.id, grams: 35 },
        { spoolId: b.id, grams: 8 },
        { spoolId: a.id, grams: 5 },
      ],
    })
    expect(await balance(a.id)).toBe(960)
    expect(await balance(b.id)).toBe(992)
    const [print] = await listPrints(db, { modelId: MODEL })
    expect(print!.filamentUsedG).toBe(48)
    expect(print!.filamentCost).toBe(1.04)
    expect(print!.filamentUsage).toHaveLength(2)
    await editFilament(db, a.filamentId, { name: 'Renamed', material: 'PLA' })
    await editSpool(db, a.id, { purchaseCost: 50 })
    const usage = (await getPrintUsage(db, [id])).get(id)!
    expect(usage.find((u) => u.spoolId === a.id)!.snapshot.name).toBe('Fixture PETG')
    await updatePrint(db, id, {
      filamentUsage: [
        { spoolId: a.id, grams: 50 },
        { spoolId: b.id, grams: 8 },
      ],
    })
    expect((await listPrints(db, { modelId: MODEL }))[0]!.filamentCost).toBe(1.24)
  })
  it.each(['success', 'partial', 'failed'] as const)(
    'deducts finished %s prints',
    async (status) => {
      const a = await add()
      await logPrint(db, { modelId: MODEL, status, filamentUsage: [{ spoolId: a.id, grams: 20 }] })
      expect(await balance(a.id)).toBe(980)
    },
  )
  it('only deducts an estimate on completion and reverses on reopening', async () => {
    const a = await add()
    const { id } = await logPrint(db, {
      modelId: MODEL,
      status: 'in_progress',
      filamentUsage: [{ spoolId: a.id, grams: 20 }],
    })
    expect(await balance(a.id)).toBe(1000)
    expect((await spoolPrints(db, a.id))[0]!.status).toBe('in_progress')
    await updatePrint(db, id, { status: 'failed' })
    expect(await balance(a.id)).toBe(980)
    await updatePrint(db, id, { status: 'failed' })
    expect(await balance(a.id)).toBe(980)
    await updatePrint(db, id, { status: 'in_progress' })
    expect(await balance(a.id)).toBe(1000)
  })
  it('preserves corrections across edits, reassignment and deletion', async () => {
    const a = await add()
    const b = await add()
    const { id } = await logPrint(db, {
      modelId: MODEL,
      filamentUsage: [{ spoolId: a.id, grams: 40 }],
    })
    await measureSpool(db, a.id, 900, 'Weighed')
    await updatePrint(db, id, { filamentUsage: [{ spoolId: a.id, grams: 50 }] })
    expect(await balance(a.id)).toBe(890)
    await updatePrint(db, id, { filamentUsage: [{ spoolId: b.id, grams: 30 }] })
    expect(await balance(a.id)).toBe(940)
    expect(await balance(b.id)).toBe(970)
    await deletePrint(db, id)
    expect(await balance(b.id)).toBe(1000)
    await deletePrint(db, id)
    expect(await balance(b.id)).toBe(1000)
  })
  it('saves negative balances and accepts a new measurement', async () => {
    const a = await add({ remainingG: 10 })
    await logPrint(db, { modelId: MODEL, filamentUsage: [{ spoolId: a.id, grams: 20 }] })
    expect(await balance(a.id)).toBe(-10)
    await measureSpool(db, a.id, 0, 'Empty')
    expect(await balance(a.id)).toBe(0)
  })
  it('handles missing prices, explicit costs and a return to automatic cost', async () => {
    const a = await add({ purchaseCost: null })
    const { id } = await logPrint(db, {
      modelId: MODEL,
      filamentUsage: [{ spoolId: a.id, grams: 20 }],
    })
    expect((await listPrints(db, { modelId: MODEL }))[0]!.filamentCost).toBeNull()
    await updatePrint(db, id, { filamentCost: 5, filamentCostManual: true })
    expect((await listPrints(db, { modelId: MODEL }))[0]!.filamentCost).toBe(5)
    await updatePrint(db, id, { filamentCostManual: false })
    expect((await listPrints(db, { modelId: MODEL }))[0]!.filamentCost).toBeNull()
  })
  it('rejects new use of archived spools but permits editing their existing usage', async () => {
    const a = await add()
    const run = await logPrint(db, {
      modelId: MODEL,
      filamentUsage: [{ spoolId: a.id, grams: 10 }],
    })
    await archiveSpool(db, a.id, true)
    await expect(
      logPrint(db, { modelId: MODEL, filamentUsage: [{ spoolId: a.id, grams: 5 }] }),
    ).rejects.toThrow('Archived')
    expect(await listPrints(db, { modelId: MODEL })).toHaveLength(1)
    await updatePrint(db, run.id, { filamentUsage: [{ spoolId: a.id, grams: 15 }] })
    expect(await balance(a.id)).toBe(985)
    await archiveSpool(db, a.id, false)
    await archiveFilament(db, a.filamentId, true)
    await expect(createSpool(db, { filamentId: a.filamentId })).rejects.toThrow('active filament')
  })
  it('serialises concurrent prints and concurrent retries of the same submission', async () => {
    const a = await add()
    const b = await add()
    const entries = [
      { spoolId: a.id, grams: 10 },
      { spoolId: b.id, grams: 20 },
    ]
    const key = crypto.randomUUID()
    const results = await Promise.all([
      logPrint(db, { modelId: MODEL, recordingKey: key, filamentUsage: entries }),
      logPrint(db, { modelId: MODEL, recordingKey: key, filamentUsage: entries }),
    ])
    expect(results[0]!.id).toBe(results[1]!.id)
    expect(await balance(a.id)).toBe(990)
    await Promise.all([
      logPrint(db, { modelId: MODEL, filamentUsage: entries }),
      logPrint(db, { modelId: MODEL, filamentUsage: [...entries].reverse() }),
    ])
    expect(await balance(a.id)).toBe(970)
    expect(await balance(b.id)).toBe(940)
    await Promise.all([
      updatePrint(db, results[0]!.id, { filamentUsage: [{ spoolId: a.id, grams: 30 }] }),
      updatePrint(db, results[0]!.id, { filamentUsage: [{ spoolId: a.id, grams: 30 }] }),
    ])
    expect(await balance(a.id)).toBe(950)
    expect(await balance(b.id)).toBe(960)
  })
  it('keeps spool-linked queue logs when reopening, even with zero grams', async () => {
    const a = await add()
    await db.execute(
      sql`INSERT INTO print_requests (id, model_id, title) VALUES (${REQUEST}, ${MODEL}, 'Cube')`,
    )
    await setRequestStatus(db, REQUEST, 'done')
    const [print] = await listPrints(db, { modelId: MODEL })
    await updatePrint(db, print!.id, { filamentUsage: [{ spoolId: a.id, grams: 0 }] })
    await setRequestStatus(db, REQUEST, 'requested')
    expect(await listPrints(db, { modelId: MODEL })).toHaveLength(1)
  })
  it('backs up and restores raw balances, links and snapshots without replay', async () => {
    const a = await add({ remainingG: 400 })
    const run = await logPrint(db, {
      modelId: MODEL,
      filamentUsage: [{ spoolId: a.id, grams: 30 }],
    })
    await measureSpool(db, a.id, 350, 'Weighed')
    const all = await db.transaction((tx) => exportFilamentInventory(tx), {
      isolationLevel: 'repeatable read',
    })
    const backup = {
      filaments: all.filaments.filter((f) => f.id === a.filamentId),
      spools: all.spools.filter((s) => s.id === a.id),
      changes: all.changes.filter((c) => c.spoolId === a.id),
      usage: all.usage.filter((u) => u.spoolId === a.id),
    }
    await db.execute(sql`DELETE FROM print_filament_usage WHERE spool_id = ${a.id}`)
    await db.execute(sql`DELETE FROM filament_stock_changes WHERE spool_id = ${a.id}`)
    await db.execute(sql`DELETE FROM filament_spools WHERE id = ${a.id}`)
    await db.execute(sql`DELETE FROM filaments WHERE id = ${a.filamentId}`)
    await restoreFilamentInventory(db, backup, new Map([[run.id, run.id]]))
    expect(await balance(a.id)).toBe(350)
    expect((await getPrintUsage(db, [run.id])).get(run.id)![0]!.snapshot.material).toBe('PETG')
    await measureSpool(db, a.id, 300, 'New measurement')
    await restoreFilamentInventory(db, backup, new Map([[run.id, run.id]]))
    expect(await balance(a.id)).toBe(300)
    await deletePrint(db, run.id)
    expect(await balance(a.id)).toBe(330)
  })
})
