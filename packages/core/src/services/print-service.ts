import { and, desc, eq, sql } from 'drizzle-orm'
import type { Database } from '@pb/db'
import { schema } from '@pb/db'

/**
 * Print history.
 *
 * A log of what was actually printed, which is the thing a working shop wants
 * most and which the reference application dropped. It answers questions the
 * files alone cannot: did this one come out, at what layer height, in what
 * material, and is it worth printing again.
 */

export type PrintStatus = 'in_progress' | 'success' | 'partial' | 'failed'

export interface PrintEntry {
  modelId: string
  modelFileId?: string | null
  userId?: string | null
  printerName?: string | null
  material?: string | null
  colorHex?: string | null
  layerHeightMm?: number | null
  nozzleMm?: number | null
  status?: PrintStatus
  startedAt?: Date | null
  finishedAt?: Date | null
  durationMin?: number | null
  filamentUsedG?: number | null
  rating?: number | null
  notes?: string | null
}

export interface PrintRun {
  id: string
  modelId: string
  modelName: string
  /** For linking back to the model from a list that spans many of them. */
  modelPublicId: string
  modelFileId: string | null
  filename: string | null
  userName: string | null
  printerName: string | null
  material: string | null
  colorHex: string | null
  layerHeightMm: number | null
  nozzleMm: number | null
  status: PrintStatus
  startedAt: Date | null
  finishedAt: Date | null
  durationMin: number | null
  filamentUsedG: number | null
  rating: number | null
  notes: string | null
  createdAt: Date
}

export interface PrintStats {
  total: number
  successes: number
  failures: number
  /** Null when nothing has finished yet — not zero, which would read as 0%. */
  successRate: number | null
  lastPrintedAt: Date | null
  totalFilamentG: number
  totalDurationMin: number
}

const MAX_NOTES = 5000

export class PrintValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PrintValidationError'
  }
}

/** Normalises and range-checks a print entry before it reaches the database. */
function validate(entry: PrintEntry): PrintEntry {
  if (entry.rating != null && (entry.rating < 1 || entry.rating > 5)) {
    throw new PrintValidationError('Rating must be between 1 and 5.')
  }
  if (entry.durationMin != null && entry.durationMin < 0) {
    throw new PrintValidationError('Duration cannot be negative.')
  }
  if (entry.filamentUsedG != null && entry.filamentUsedG < 0) {
    throw new PrintValidationError('Filament used cannot be negative.')
  }
  if (entry.layerHeightMm != null && (entry.layerHeightMm <= 0 || entry.layerHeightMm > 5)) {
    // Outside this range it is a typo, not a layer height.
    throw new PrintValidationError('Layer height must be between 0 and 5 mm.')
  }
  if (
    entry.startedAt &&
    entry.finishedAt &&
    entry.finishedAt.getTime() < entry.startedAt.getTime()
  ) {
    throw new PrintValidationError('A print cannot finish before it started.')
  }
  if (entry.colorHex && !/^#[0-9a-f]{6}$/i.test(entry.colorHex)) {
    throw new PrintValidationError('Colour must be a hex value like #1a2b3c.')
  }
  return entry
}

export async function logPrint(db: Database, entry: PrintEntry): Promise<{ id: string }> {
  const clean = validate(entry)

  /*
   * Derive the duration when both ends are known. Asking for it as well as the
   * start and end times invites the two to disagree.
   */
  const duration =
    clean.durationMin ??
    (clean.startedAt && clean.finishedAt
      ? Math.max(0, Math.round((clean.finishedAt.getTime() - clean.startedAt.getTime()) / 60_000))
      : null)

  const [row] = await db
    .insert(schema.printRuns)
    .values({
      modelId: clean.modelId,
      modelFileId: clean.modelFileId ?? null,
      userId: clean.userId ?? null,
      printerName: clean.printerName?.trim() || null,
      material: clean.material?.trim() || null,
      colorHex: clean.colorHex ?? null,
      layerHeightMm: clean.layerHeightMm != null ? String(clean.layerHeightMm) : null,
      nozzleMm: clean.nozzleMm != null ? String(clean.nozzleMm) : null,
      status: clean.status ?? 'success',
      startedAt: clean.startedAt ?? null,
      finishedAt: clean.finishedAt ?? null,
      durationMin: duration,
      filamentUsedG: clean.filamentUsedG != null ? String(clean.filamentUsedG) : null,
      rating: clean.rating ?? null,
      notes: clean.notes?.slice(0, MAX_NOTES) || null,
    })
    .returning({ id: schema.printRuns.id })

  return { id: row!.id }
}

export async function updatePrint(
  db: Database,
  printId: string,
  entry: Partial<PrintEntry>,
): Promise<void> {
  validate(entry as PrintEntry)

  const updates: Record<string, unknown> = { updatedAt: new Date() }
  if (entry.status !== undefined) updates.status = entry.status
  if (entry.rating !== undefined) updates.rating = entry.rating
  if (entry.notes !== undefined) updates.notes = entry.notes?.slice(0, MAX_NOTES) || null
  if (entry.printerName !== undefined) updates.printerName = entry.printerName?.trim() || null
  if (entry.material !== undefined) updates.material = entry.material?.trim() || null
  if (entry.finishedAt !== undefined) updates.finishedAt = entry.finishedAt
  if (entry.durationMin !== undefined) updates.durationMin = entry.durationMin
  if (entry.filamentUsedG !== undefined) {
    updates.filamentUsedG = entry.filamentUsedG != null ? String(entry.filamentUsedG) : null
  }

  await db.update(schema.printRuns).set(updates).where(eq(schema.printRuns.id, printId))
}

export async function deletePrint(db: Database, printId: string): Promise<void> {
  await db.delete(schema.printRuns).where(eq(schema.printRuns.id, printId))
}

export async function listPrints(
  db: Database,
  options: {
    modelId?: string
    /** Empty or absent means every outcome. */
    status?: PrintStatus[]
    limit?: number
    offset?: number
  } = {},
): Promise<PrintRun[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)

  const conditions = [
    options.modelId ? sql`p.model_id = ${options.modelId}` : null,
    /*
     * sql.param() rather than a bare array: Drizzle spreads a plain array into
     * separate placeholders, which turns `= ANY($1)` into `= ANY($1,$2)` and
     * fails at the database rather than here.
     */
    options.status?.length
      ? sql`p.status = ANY(${sql.param(options.status)}::print_status[])`
      : null,
  ].filter(Boolean) as ReturnType<typeof sql>[]

  const where =
    conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``

  const rows = await db.execute<{
    id: string
    model_id: string
    model_name: string
    model_public_id: string
    model_file_id: string | null
    filename: string | null
    user_name: string | null
    printer_name: string | null
    material: string | null
    color_hex: string | null
    layer_height_mm: string | null
    nozzle_mm: string | null
    status: PrintStatus
    started_at: string | null
    finished_at: string | null
    duration_min: number | null
    filament_used_g: string | null
    rating: number | null
    notes: string | null
    created_at: string
  }>(sql`
    SELECT p.id, p.model_id, m.name AS model_name, m.public_id AS model_public_id,
           p.model_file_id, f.filename, u.name AS user_name,
           p.printer_name, p.material, p.color_hex, p.layer_height_mm, p.nozzle_mm,
           p.status, p.started_at, p.finished_at, p.duration_min, p.filament_used_g,
           p.rating, p.notes, p.created_at
    FROM print_runs p
    JOIN models m ON m.id = p.model_id
    LEFT JOIN model_files f ON f.id = p.model_file_id
    LEFT JOIN "user" u ON u.id = p.user_id
    ${where}
    -- Newest first, falling back to created_at for a print with no start time.
    ORDER BY coalesce(p.started_at, p.created_at) DESC, p.created_at DESC
    LIMIT ${limit} OFFSET ${Math.max(options.offset ?? 0, 0)}
  `)

  return rows.rows.map((row) => ({
    id: row.id,
    modelId: row.model_id,
    modelName: row.model_name,
    modelPublicId: row.model_public_id,
    modelFileId: row.model_file_id,
    filename: row.filename,
    userName: row.user_name,
    printerName: row.printer_name,
    material: row.material,
    colorHex: row.color_hex,
    layerHeightMm: row.layer_height_mm === null ? null : Number(row.layer_height_mm),
    nozzleMm: row.nozzle_mm === null ? null : Number(row.nozzle_mm),
    status: row.status,
    startedAt: row.started_at ? new Date(row.started_at) : null,
    finishedAt: row.finished_at ? new Date(row.finished_at) : null,
    durationMin: row.duration_min,
    filamentUsedG: row.filament_used_g === null ? null : Number(row.filament_used_g),
    rating: row.rating,
    notes: row.notes,
    createdAt: new Date(row.created_at),
  }))
}

export async function printStats(db: Database, modelId?: string): Promise<PrintStats> {
  const result = await db.execute<{
    total: number
    successes: number
    failures: number
    last_printed_at: string | null
    total_filament: string | null
    total_duration: number | null
  }>(sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE status = 'success')::int AS successes,
           count(*) FILTER (WHERE status = 'failed')::int AS failures,
           max(coalesce(started_at, created_at)) AS last_printed_at,
           coalesce(sum(filament_used_g), 0) AS total_filament,
           coalesce(sum(duration_min), 0)::int AS total_duration
    FROM print_runs
    ${modelId ? sql`WHERE model_id = ${modelId}` : sql``}
  `)

  const row = result.rows[0]
  const successes = row?.successes ?? 0
  const failures = row?.failures ?? 0
  const settled = successes + failures

  return {
    total: row?.total ?? 0,
    successes,
    failures,
    /*
     * Null rather than zero when nothing has finished. A brand-new model with
     * one print still running is not a 0% success rate, and showing it as one
     * is actively misleading.
     */
    successRate: settled > 0 ? successes / settled : null,
    lastPrintedAt: row?.last_printed_at ? new Date(row.last_printed_at) : null,
    totalFilamentG: Number(row?.total_filament ?? 0),
    totalDurationMin: row?.total_duration ?? 0,
  }
}

/** Materials and printers already used, so the form can suggest rather than ask. */
export async function printSuggestions(
  db: Database,
): Promise<{ materials: string[]; printers: string[] }> {
  const [materials, printers] = await Promise.all([
    db.execute<{ value: string }>(sql`
      SELECT material AS value FROM print_runs WHERE material IS NOT NULL
      GROUP BY material ORDER BY count(*) DESC LIMIT 30`),
    db.execute<{ value: string }>(sql`
      SELECT printer_name AS value FROM print_runs WHERE printer_name IS NOT NULL
      GROUP BY printer_name ORDER BY count(*) DESC LIMIT 30`),
  ])

  return {
    materials: materials.rows.map((row) => row.value),
    printers: printers.rows.map((row) => row.value),
  }
}

/** Confirms a print belongs to the model it claims, before editing or deleting. */
export async function printBelongsToModel(
  db: Database,
  printId: string,
  modelId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: schema.printRuns.id })
    .from(schema.printRuns)
    .where(and(eq(schema.printRuns.id, printId), eq(schema.printRuns.modelId, modelId)))
    .limit(1)
  return rows.length > 0
}

export { desc }
