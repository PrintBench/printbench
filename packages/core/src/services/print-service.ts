import { and, desc, eq, sql } from 'drizzle-orm'
import type { Database } from '@pb/db'
import { schema } from '@pb/db'
import { BED_ADHESIONS, NOZZLE_TYPES, type BedAdhesion, type NozzleType } from './print-fields'

/*
 * Re-exported so the barrel still offers them alongside everything else
 * print-shaped. The definitions live in print-fields because the form that
 * renders them runs in the browser; see the note at the top of that file.
 */
export * from './print-fields'

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
  nozzleType?: NozzleType | null
  filamentBrand?: string | null
  colorName?: string | null
  filamentCost?: number | null
  infillPercent?: number | null
  wallCount?: number | null
  /** Null is unknown; false is a deliberate "no supports". */
  supports?: boolean | null
  adhesion?: BedAdhesion | null
  nozzleTempC?: number | null
  bedTempC?: number | null
  slicerName?: string | null
  slicerVersion?: string | null
  slicerProfile?: string | null
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
  nozzleType: NozzleType | null
  filamentBrand: string | null
  colorName: string | null
  filamentCost: number | null
  infillPercent: number | null
  wallCount: number | null
  supports: boolean | null
  adhesion: BedAdhesion | null
  nozzleTempC: number | null
  bedTempC: number | null
  slicerName: string | null
  slicerVersion: string | null
  slicerProfile: string | null
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
  if (entry.infillPercent != null && (entry.infillPercent < 0 || entry.infillPercent > 100)) {
    throw new PrintValidationError('Infill must be between 0 and 100 percent.')
  }
  if (entry.wallCount != null && (entry.wallCount < 0 || entry.wallCount > 100)) {
    throw new PrintValidationError('Wall count must be between 0 and 100.')
  }
  if (entry.nozzleTempC != null && (entry.nozzleTempC < 0 || entry.nozzleTempC > 500)) {
    throw new PrintValidationError('Nozzle temperature must be between 0 and 500 °C.')
  }
  if (entry.bedTempC != null && (entry.bedTempC < 0 || entry.bedTempC > 500)) {
    throw new PrintValidationError('Bed temperature must be between 0 and 500 °C.')
  }
  if (entry.filamentCost != null && entry.filamentCost < 0) {
    throw new PrintValidationError('Cost cannot be negative.')
  }
  /*
   * Checked here as well as by the column type. Postgres would reject a bad
   * value too, but as a 22P02 with the enum name in it — this says which field
   * and in words the form can show.
   */
  if (entry.nozzleType != null && !NOZZLE_TYPES.includes(entry.nozzleType)) {
    throw new PrintValidationError('That is not a nozzle type we recognise.')
  }
  if (entry.adhesion != null && !BED_ADHESIONS.includes(entry.adhesion)) {
    throw new PrintValidationError('That is not an adhesion type we recognise.')
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
      nozzleType: clean.nozzleType ?? null,
      filamentBrand: clean.filamentBrand?.trim() || null,
      colorName: clean.colorName?.trim() || null,
      filamentCost: clean.filamentCost != null ? String(clean.filamentCost) : null,
      infillPercent: clean.infillPercent ?? null,
      wallCount: clean.wallCount ?? null,
      supports: clean.supports ?? null,
      adhesion: clean.adhesion ?? null,
      nozzleTempC: clean.nozzleTempC ?? null,
      bedTempC: clean.bedTempC ?? null,
      slicerName: clean.slicerName?.trim() || null,
      slicerVersion: clean.slicerVersion?.trim() || null,
      slicerProfile: clean.slicerProfile?.trim() || null,
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

/** Everything about a print that can be edited after the fact. */
type EditableField = Exclude<keyof PrintEntry, 'modelId' | 'userId'>

/**
 * How each editable field reaches its column.
 *
 * A table rather than a run of `if` statements, and typed as a complete Record
 * so the compiler refuses a field that is missing from it. The hand-written list
 * this replaces had quietly fallen behind the form: layer height, nozzle
 * diameter, colour and the start time were all editable in the UI and all
 * silently discarded on save, because nothing connected adding a field to
 * PrintEntry with remembering to list it here.
 *
 * `numeric` columns take strings — Postgres hands them back as strings too, and
 * passing a JavaScript number through drizzle's numeric mapping loses the exact
 * decimal the user typed.
 */
const EDITABLE: Record<EditableField, (entry: Partial<PrintEntry>) => unknown> = {
  modelFileId: (e) => e.modelFileId || null,
  printerName: (e) => e.printerName?.trim() || null,
  material: (e) => e.material?.trim() || null,
  colorHex: (e) => e.colorHex ?? null,
  layerHeightMm: (e) => numericOrNull(e.layerHeightMm),
  nozzleMm: (e) => numericOrNull(e.nozzleMm),
  nozzleType: (e) => e.nozzleType ?? null,
  filamentBrand: (e) => e.filamentBrand?.trim() || null,
  colorName: (e) => e.colorName?.trim() || null,
  filamentCost: (e) => numericOrNull(e.filamentCost),
  infillPercent: (e) => e.infillPercent ?? null,
  wallCount: (e) => e.wallCount ?? null,
  supports: (e) => e.supports ?? null,
  adhesion: (e) => e.adhesion ?? null,
  nozzleTempC: (e) => e.nozzleTempC ?? null,
  bedTempC: (e) => e.bedTempC ?? null,
  slicerName: (e) => e.slicerName?.trim() || null,
  slicerVersion: (e) => e.slicerVersion?.trim() || null,
  slicerProfile: (e) => e.slicerProfile?.trim() || null,
  status: (e) => e.status ?? 'success',
  startedAt: (e) => e.startedAt ?? null,
  finishedAt: (e) => e.finishedAt ?? null,
  durationMin: (e) => e.durationMin ?? null,
  filamentUsedG: (e) => numericOrNull(e.filamentUsedG),
  rating: (e) => e.rating ?? null,
  notes: (e) => e.notes?.slice(0, MAX_NOTES) || null,
}

function numericOrNull(value: number | null | undefined): string | null {
  return value != null ? String(value) : null
}

export async function updatePrint(
  db: Database,
  printId: string,
  entry: Partial<PrintEntry>,
): Promise<void> {
  validate(entry as PrintEntry)

  const updates: Record<string, unknown> = { updatedAt: new Date() }

  // `undefined` means "not sent, leave it alone"; an explicit null clears.
  for (const field of Object.keys(EDITABLE) as EditableField[]) {
    if (entry[field] !== undefined) updates[field] = EDITABLE[field](entry)
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

  const where = conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``

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
    nozzle_type: NozzleType | null
    filament_brand: string | null
    color_name: string | null
    filament_cost: string | null
    infill_percent: number | null
    wall_count: number | null
    supports: boolean | null
    adhesion: BedAdhesion | null
    nozzle_temp_c: number | null
    bed_temp_c: number | null
    slicer_name: string | null
    slicer_version: string | null
    slicer_profile: string | null
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
           p.nozzle_type, p.filament_brand, p.color_name, p.filament_cost,
           p.infill_percent, p.wall_count, p.supports, p.adhesion,
           p.nozzle_temp_c, p.bed_temp_c,
           p.slicer_name, p.slicer_version, p.slicer_profile,
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
    nozzleType: row.nozzle_type,
    filamentBrand: row.filament_brand,
    colorName: row.color_name,
    // numeric arrives as a string, like layer height and nozzle above.
    filamentCost: row.filament_cost === null ? null : Number(row.filament_cost),
    infillPercent: row.infill_percent,
    wallCount: row.wall_count,
    supports: row.supports,
    adhesion: row.adhesion,
    nozzleTempC: row.nozzle_temp_c,
    bedTempC: row.bed_temp_c,
    slicerName: row.slicer_name,
    slicerVersion: row.slicer_version,
    slicerProfile: row.slicer_profile,
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

/**
 * Values already used, so the form can suggest rather than ask.
 *
 * All free text, so the same spool typed two ways stays two values. Ordering by
 * frequency is what keeps that tolerable: the spelling someone actually uses
 * rises to the top of the list and gets picked next time.
 */
export async function printSuggestions(
  db: Database,
): Promise<{ materials: string[]; printers: string[]; filamentBrands: string[] }> {
  const [materials, printers, brands] = await Promise.all([
    db.execute<{ value: string }>(sql`
      SELECT material AS value FROM print_runs WHERE material IS NOT NULL
      GROUP BY material ORDER BY count(*) DESC LIMIT 30`),
    db.execute<{ value: string }>(sql`
      SELECT printer_name AS value FROM print_runs WHERE printer_name IS NOT NULL
      GROUP BY printer_name ORDER BY count(*) DESC LIMIT 30`),
    db.execute<{ value: string }>(sql`
      SELECT filament_brand AS value FROM print_runs WHERE filament_brand IS NOT NULL
      GROUP BY filament_brand ORDER BY count(*) DESC LIMIT 30`),
  ])

  return {
    materials: materials.rows.map((row) => row.value),
    printers: printers.rows.map((row) => row.value),
    filamentBrands: brands.rows.map((row) => row.value),
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
