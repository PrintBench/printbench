import { eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { schema, type Database } from '@pb/db'
import type { FilamentDb } from './filament-service'

const id = z.string().uuid()
const decimal = z.string().refine((value) => Number.isFinite(Number(value)), 'Invalid decimal')
const date = z.string().datetime({ offset: true })
const snapshot = z.object({
  name: z.string(),
  brand: z.string().nullable(),
  material: z.string(),
  colorName: z.string().nullable(),
  colorHex: z.string().nullable(),
  diameterMm: z.number(),
  nozzleTempC: z.number().nullable(),
  bedTempC: z.number().nullable(),
  spoolLabel: z.string().nullable(),
})
export const filamentBackupSchema = z.object({
  filaments: z.array(
    z.object({
      id,
      name: z.string(),
      brand: z.string().nullable(),
      material: z.string(),
      colorName: z.string().nullable(),
      colorHex: z.string().nullable(),
      diameterMm: decimal,
      nozzleTempC: decimal.nullable(),
      bedTempC: decimal.nullable(),
      notes: z.string().nullable(),
      archivedAt: date.nullable(),
      createdAt: date,
      updatedAt: date,
    }),
  ),
  spools: z.array(
    z.object({
      id,
      filamentId: id,
      label: z.string().nullable(),
      nominalWeightG: decimal,
      emptyWeightG: decimal.nullable(),
      purchaseCost: decimal.nullable(),
      location: z.string().nullable(),
      notes: z.string().nullable(),
      lowStockG: decimal,
      archivedAt: date.nullable(),
      createdAt: date,
      updatedAt: date,
    }),
  ),
  changes: z.array(
    z.object({
      id,
      spoolId: id,
      amountG: decimal,
      kind: z.enum(['opening', 'correction', 'consumption', 'reversal']),
      reason: z.string(),
      printRunId: id.nullable(),
      actorId: z.string().nullable(),
      createdAt: date,
    }),
  ),
  usage: z.array(
    z.object({
      id,
      printRunId: id,
      spoolId: id,
      grams: decimal,
      snapshot,
      costPerGram: decimal.nullable(),
    }),
  ),
})
export type FilamentInventoryBackup = z.infer<typeof filamentBackupSchema>
export async function exportFilamentInventory(db: FilamentDb): Promise<FilamentInventoryBackup> {
  // The caller supplies a repeatable-read transaction for a consistent backup.
  const tx = db
  const filaments = await tx.select().from(schema.filaments)
  const spools = await tx.select().from(schema.filamentSpools)
  const changes = await tx.select().from(schema.filamentStockChanges)
  const usage = await tx.select().from(schema.printFilamentUsage)
  return filamentBackupSchema.parse(
    JSON.parse(JSON.stringify({ filaments, spools, changes, usage })),
  )
}
/** Restore raw deltas; calling logPrint here would consume the stock twice. */
export async function restoreFilamentInventory(
  db: Database,
  input: FilamentInventoryBackup,
  restoredPrintIds: Map<string, string> = new Map(),
) {
  const backup = filamentBackupSchema.parse(input)
  return db.transaction(async (tx) => {
    const users = new Set(
      (await tx.select({ id: schema.user.id }).from(schema.user)).map((u) => u.id),
    )
    for (const row of backup.filaments)
      await tx
        .insert(schema.filaments)
        .values({
          ...row,
          createdAt: new Date(row.createdAt),
          updatedAt: new Date(row.updatedAt),
          archivedAt: row.archivedAt ? new Date(row.archivedAt) : null,
        })
        .onConflictDoNothing()
    const restoredSpools = new Set<string>()
    for (const row of backup.spools) {
      const added = await tx
        .insert(schema.filamentSpools)
        .values({
          ...row,
          createdAt: new Date(row.createdAt),
          updatedAt: new Date(row.updatedAt),
          archivedAt: row.archivedAt ? new Date(row.archivedAt) : null,
        })
        .onConflictDoNothing()
        .returning({ id: schema.filamentSpools.id })
      if (added.length) restoredSpools.add(row.id)
    }
    for (const row of backup.changes) {
      if (!restoredSpools.has(row.spoolId)) continue
      await tx
        .insert(schema.filamentStockChanges)
        .values({
          ...row,
          actorId: row.actorId && users.has(row.actorId) ? row.actorId : null,
          printRunId: row.printRunId
            ? (restoredPrintIds.get(row.printRunId) ?? row.printRunId)
            : null,
          createdAt: new Date(row.createdAt),
        })
        .onConflictDoNothing()
    }
    for (const row of backup.usage) {
      const printRunId = restoredPrintIds.get(row.printRunId)
      // Existing spools retain their current balance and history in full.
      if (!printRunId || !restoredSpools.has(row.spoolId)) continue
      const [print] = await tx
        .select({ id: schema.printRuns.id })
        .from(schema.printRuns)
        .where(eq(schema.printRuns.id, printRunId))
      if (print)
        await tx
          .insert(schema.printFilamentUsage)
          .values({ ...row, printRunId })
          .onConflictDoNothing()
    }
    // Prints with unavailable models retain stock history but no dangling usage FK.
    const restored = [...restoredPrintIds.values()]
    if (restored.length) {
      const linked = await tx
        .select({ printRunId: schema.printFilamentUsage.printRunId })
        .from(schema.printFilamentUsage)
        .where(inArray(schema.printFilamentUsage.printRunId, restored))
      return {
        spoolsAdded: restoredSpools.size,
        printsLinked: new Set(linked.map((row) => row.printRunId)).size,
      }
    }
    return { spoolsAdded: restoredSpools.size, printsLinked: 0 }
  })
}
