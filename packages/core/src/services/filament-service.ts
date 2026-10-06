import { asc, eq, inArray, sql } from 'drizzle-orm'
import { schema, type Database } from '@pb/db'
import type { FilamentSnapshot } from '@pb/db'
import {
  combineUsage,
  FilamentValidationError,
  weight,
  type FilamentInput,
  type FilamentUsageInput,
  type SpoolInput,
} from './filament-fields'
export * from './filament-fields'

// Both a database and a transaction implement this subset.
export type FilamentDb = Pick<Database, 'select' | 'insert' | 'update' | 'delete' | 'execute'>
export interface Filament extends FilamentInput {
  id: string
  archived: boolean
}
export interface Spool {
  id: string
  filamentId: string
  filament: Filament
  label: string | null
  nominalWeightG: number
  remainingG: number
  emptyWeightG: number | null
  purchaseCost: number | null
  location: string | null
  notes: string | null
  lowStockG: number
  archived: boolean
  spoolArchived: boolean
}
export interface FilamentUsage extends FilamentUsageInput {
  snapshot: FilamentSnapshot
  costPerGram: number | null
}
const text = (value?: string | null) => value?.trim().slice(0, 5000) || null
const number = (value: string | null) => (value === null ? null : Number(value))
function validateFilament(input: FilamentInput) {
  if (!text(input.name) || !text(input.material))
    throw new FilamentValidationError('Name and material are required.')
  if (input.colorHex && !/^#[0-9a-f]{6}$/i.test(input.colorHex))
    throw new FilamentValidationError('Choose a colour like #112233.')
  const diameter = input.diameterMm ?? 1.75
  if (!Number.isFinite(diameter) || diameter < 0.01 || diameter > 10)
    throw new FilamentValidationError('Diameter must be between 0.01 and 10 mm.')
  for (const temperature of [input.nozzleTempC, input.bedTempC])
    if (
      temperature != null &&
      (!Number.isInteger(temperature) || temperature < 0 || temperature > 500)
    )
      throw new FilamentValidationError('Temperatures must be whole numbers between 0 and 500 °C.')
  return {
    name: text(input.name)!,
    material: text(input.material)!,
    brand: text(input.brand),
    colorName: text(input.colorName),
    colorHex: input.colorHex || null,
    diameterMm: String(diameter),
    nozzleTempC: input.nozzleTempC == null ? null : String(input.nozzleTempC),
    bedTempC: input.bedTempC == null ? null : String(input.bedTempC),
    notes: text(input.notes),
  }
}
export async function listFilaments(db: FilamentDb): Promise<Filament[]> {
  const rows = await db.select().from(schema.filaments).orderBy(asc(schema.filaments.name))
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    material: row.material,
    brand: row.brand,
    colorName: row.colorName,
    colorHex: row.colorHex,
    diameterMm: Number(row.diameterMm),
    nozzleTempC: number(row.nozzleTempC),
    bedTempC: number(row.bedTempC),
    notes: row.notes,
    archived: row.archivedAt != null,
  }))
}
export async function createFilament(db: FilamentDb, input: FilamentInput): Promise<string> {
  const [row] = await db
    .insert(schema.filaments)
    .values(validateFilament(input))
    .returning({ id: schema.filaments.id })
  return row!.id
}
export async function editFilament(db: Database, id: string, input: FilamentInput) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM filaments WHERE id = ${id} FOR UPDATE`)
    const rows = await tx
      .update(schema.filaments)
      .set({ ...validateFilament(input), updatedAt: new Date() })
      .where(eq(schema.filaments.id, id))
      .returning({ id: schema.filaments.id })
    if (!rows.length) throw new FilamentValidationError('That filament no longer exists.')
  })
}
export async function listSpools(db: FilamentDb): Promise<Spool[]> {
  const [rows, filaments, balances] = await Promise.all([
    db.select().from(schema.filamentSpools).orderBy(asc(schema.filamentSpools.createdAt)),
    listFilaments(db),
    db.execute<{ spool_id: string; balance: string }>(
      sql`SELECT spool_id, sum(amount_g) AS balance FROM filament_stock_changes GROUP BY spool_id`,
    ),
  ])
  const byId = new Map(filaments.map((f) => [f.id, f]))
  const bySpool = new Map(balances.rows.map((r) => [r.spool_id, Number(r.balance)]))
  return rows.map((row) => ({
    id: row.id,
    filamentId: row.filamentId,
    filament: byId.get(row.filamentId)!,
    label: row.label,
    nominalWeightG: Number(row.nominalWeightG),
    remainingG: bySpool.get(row.id) ?? 0,
    emptyWeightG: number(row.emptyWeightG),
    purchaseCost: number(row.purchaseCost),
    location: row.location,
    notes: row.notes,
    lowStockG: Number(row.lowStockG),
    spoolArchived: row.archivedAt != null,
    archived: row.archivedAt != null || byId.get(row.filamentId)!.archived,
  }))
}
function spoolValues(input: SpoolInput) {
  return {
    label: text(input.label),
    nominalWeightG: String(weight(input.nominalWeightG ?? 1000, 'Nominal weight', true)),
    emptyWeightG:
      input.emptyWeightG == null ? null : String(weight(input.emptyWeightG, 'Empty spool weight')),
    purchaseCost:
      input.purchaseCost == null ? null : String(weight(input.purchaseCost, 'Purchase cost')),
    location: text(input.location),
    notes: text(input.notes),
    lowStockG: String(weight(input.lowStockG ?? 100, 'Low stock threshold')),
  }
}
export async function createSpool(
  db: Database,
  input: SpoolInput,
  actorId?: string,
): Promise<string> {
  return db.transaction(async (tx) => {
    const filamentId =
      input.filamentId || (input.filament ? await createFilament(tx, input.filament) : null)
    if (!filamentId) throw new FilamentValidationError('Choose or create a filament.')
    const [filament] = await tx
      .select()
      .from(schema.filaments)
      .where(eq(schema.filaments.id, filamentId))
      .for('update')
    if (!filament || filament.archivedAt)
      throw new FilamentValidationError('Choose an active filament.')
    const [spool] = await tx
      .insert(schema.filamentSpools)
      .values({ ...spoolValues(input), filamentId })
      .returning({ id: schema.filamentSpools.id })
    await tx.insert(schema.filamentStockChanges).values({
      spoolId: spool!.id,
      amountG: String(weight(input.remainingG ?? input.nominalWeightG ?? 1000, 'Starting weight')),
      kind: 'opening',
      reason: 'Starting filament weight',
      actorId,
    })
    return spool!.id
  })
}
export async function editSpool(db: Database, id: string, input: SpoolInput) {
  await db.transaction(async (tx) => {
    await lockSpools(tx, [id])
    await tx
      .update(schema.filamentSpools)
      .set({ ...spoolValues(input), updatedAt: new Date() })
      .where(eq(schema.filamentSpools.id, id))
  })
}
export async function archiveSpool(db: Database, id: string, archived: boolean) {
  await db.transaction(async (tx) => {
    await lockSpools(tx, [id])
    await tx
      .update(schema.filamentSpools)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(eq(schema.filamentSpools.id, id))
  })
}
export async function archiveFilament(db: Database, id: string, archived: boolean) {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.filaments)
      .where(eq(schema.filaments.id, id))
      .for('update')
    if (!row) throw new FilamentValidationError('That filament no longer exists.')
    const ids = await tx
      .select({ id: schema.filamentSpools.id })
      .from(schema.filamentSpools)
      .where(eq(schema.filamentSpools.filamentId, id))
    await lockSpools(
      tx,
      ids.map((s) => s.id),
    )
    await tx
      .update(schema.filaments)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(eq(schema.filaments.id, id))
  })
}
export async function measureSpool(
  db: Database,
  id: string,
  remainingG: number,
  reason: string,
  actorId?: string,
) {
  const target = weight(remainingG, 'Remaining weight')
  if (!text(reason)) throw new FilamentValidationError('Enter a reason for the correction.')
  await db.transaction(async (tx) => {
    await lockSpools(tx, [id])
    const result = await tx.execute<{ balance: string }>(
      sql`SELECT coalesce(sum(amount_g), 0) AS balance FROM filament_stock_changes WHERE spool_id = ${id}`,
    )
    const delta = Math.round((target - Number(result.rows[0]!.balance)) * 100) / 100
    await tx.insert(schema.filamentStockChanges).values({
      spoolId: id,
      amountG: String(delta),
      kind: 'correction',
      reason: text(reason)!,
      actorId,
    })
  })
}
export async function spoolHistory(db: FilamentDb, id: string) {
  const rows = await db.execute<{
    id: string
    amount_g: string
    kind: string
    reason: string
    actor_name: string | null
    created_at: Date
    print_run_id: string | null
    model_name: string | null
    model_public_id: string | null
  }>(sql`
    SELECT c.id, c.amount_g, c.kind, c.reason, u.name AS actor_name, c.created_at, c.print_run_id,
           m.name AS model_name, m.public_id AS model_public_id
    FROM filament_stock_changes c LEFT JOIN "user" u ON u.id = c.actor_id
    LEFT JOIN print_runs p ON p.id = c.print_run_id LEFT JOIN models m ON m.id = p.model_id
    WHERE c.spool_id = ${id} ORDER BY c.created_at DESC, c.id`)
  return rows.rows.map((row) => ({
    ...row,
    amount_g: Number(row.amount_g),
    created_at: new Date(row.created_at).toISOString(),
  }))
}
/** Includes in-progress and zero-gram allocations, which have no stock delta yet. */
export async function spoolPrints(db: FilamentDb, spoolId: string) {
  const rows = await db.execute<{
    id: string
    model_name: string
    model_public_id: string
    status: string
    grams: string
    snapshot: FilamentSnapshot
    created_at: Date
  }>(sql`
    SELECT p.id, m.name AS model_name, m.public_id AS model_public_id,
           p.status, a.grams, a.snapshot, p.created_at
    FROM print_filament_usage a JOIN print_runs p ON p.id = a.print_run_id
    JOIN models m ON m.id = p.model_id
    WHERE a.spool_id = ${spoolId} ORDER BY p.created_at DESC, p.id`)
  return rows.rows.map((row) => ({
    ...row,
    grams: Number(row.grams),
    created_at: new Date(row.created_at).toISOString(),
  }))
}
export async function getPrintUsage(
  db: FilamentDb,
  printIds: string[],
): Promise<Map<string, FilamentUsage[]>> {
  if (!printIds.length) return new Map()
  const rows = await db
    .select()
    .from(schema.printFilamentUsage)
    .where(inArray(schema.printFilamentUsage.printRunId, printIds))
  const result = new Map<string, FilamentUsage[]>()
  for (const row of rows)
    result.set(row.printRunId, [
      ...(result.get(row.printRunId) ?? []),
      {
        spoolId: row.spoolId,
        grams: Number(row.grams),
        snapshot: row.snapshot,
        costPerGram: number(row.costPerGram),
      },
    ])
  return result
}
async function lockSpools(db: FilamentDb, ids: string[]) {
  if (!ids.length) return
  const rows = await db
    .select()
    .from(schema.filamentSpools)
    .where(inArray(schema.filamentSpools.id, [...new Set(ids)].sort()))
    .orderBy(asc(schema.filamentSpools.id))
    .for('update')
  if (rows.length !== new Set(ids).size)
    throw new FilamentValidationError('A selected spool no longer exists.')
}
/** Caller holds the print row lock. Spools are always locked in UUID order. */
export async function reconcilePrintUsage(
  db: FilamentDb,
  printId: string,
  input: FilamentUsageInput[] | undefined,
  previousStatus: string,
  nextStatus: string,
  actorId?: string,
) {
  const previous = (await getPrintUsage(db, [printId])).get(printId) ?? []
  const next = input === undefined ? previous : combineUsage(input)
  await lockSpools(
    db,
    [...previous, ...next].map((row) => row.spoolId),
  )
  const spools = next.length
    ? await db
        .select({ spool: schema.filamentSpools, filament: schema.filaments })
        .from(schema.filamentSpools)
        .innerJoin(schema.filaments, eq(schema.filaments.id, schema.filamentSpools.filamentId))
        .where(
          inArray(
            schema.filamentSpools.id,
            next.map((row) => row.spoolId),
          ),
        )
    : []
  const usages: FilamentUsage[] = next.map((row) => {
    const old = previous.find((p) => p.spoolId === row.spoolId)
    if (old) return { ...old, grams: row.grams }
    const found = spools.find((s) => s.spool.id === row.spoolId)!
    if (found.spool.archivedAt || found.filament.archivedAt)
      throw new FilamentValidationError('Archived spools cannot be added to a print.')
    const f = found.filament
    return {
      ...row,
      costPerGram:
        found.spool.purchaseCost == null
          ? null
          : Number(
              (Number(found.spool.purchaseCost) / Number(found.spool.nominalWeightG)).toFixed(8),
            ),
      snapshot: {
        name: f.name,
        brand: f.brand,
        material: f.material,
        colorName: f.colorName,
        colorHex: f.colorHex,
        diameterMm: Number(f.diameterMm),
        nozzleTempC: number(f.nozzleTempC),
        bedTempC: number(f.bedTempC),
        spoolLabel: found.spool.label,
      },
    }
  })
  for (const spoolId of [...new Set([...previous, ...usages].map((row) => row.spoolId))].sort()) {
    const before =
      previousStatus === 'in_progress'
        ? 0
        : (previous.find((row) => row.spoolId === spoolId)?.grams ?? 0)
    const after =
      nextStatus === 'in_progress' ? 0 : (usages.find((row) => row.spoolId === spoolId)?.grams ?? 0)
    const delta = Math.round((before - after) * 100) / 100
    if (delta)
      await db.insert(schema.filamentStockChanges).values({
        spoolId,
        amountG: String(delta),
        kind: delta < 0 ? 'consumption' : 'reversal',
        reason: delta < 0 ? 'Recorded print usage' : 'Print usage reversed or corrected',
        printRunId: printId,
        actorId,
      })
  }
  await db
    .delete(schema.printFilamentUsage)
    .where(eq(schema.printFilamentUsage.printRunId, printId))
  if (usages.length)
    await db.insert(schema.printFilamentUsage).values(
      usages.map((row) => ({
        printRunId: printId,
        spoolId: row.spoolId,
        grams: String(row.grams),
        snapshot: row.snapshot,
        costPerGram: row.costPerGram == null ? null : String(row.costPerGram),
      })),
    )
  return usages
}
