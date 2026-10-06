export interface FilamentInput {
  name: string
  material: string
  brand?: string | null
  colorName?: string | null
  colorHex?: string | null
  diameterMm?: number
  nozzleTempC?: number | null
  bedTempC?: number | null
  notes?: string | null
}
export interface SpoolInput {
  filamentId?: string
  filament?: FilamentInput
  label?: string | null
  nominalWeightG?: number
  remainingG?: number
  emptyWeightG?: number | null
  purchaseCost?: number | null
  location?: string | null
  notes?: string | null
  lowStockG?: number
}
export interface FilamentUsageInput {
  spoolId: string
  grams: number
}
export class FilamentValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FilamentValidationError'
  }
}
export function weight(value: number, label = 'Weight', positive = false): number {
  if (!Number.isFinite(value) || value < 0 || (positive && value === 0) || value > 99999999) {
    throw new FilamentValidationError(
      `${label} must be a ${positive ? 'positive' : 'non-negative'} number below 100,000,000.`,
    )
  }
  const rounded = Math.round(value * 100) / 100
  if (positive && rounded === 0)
    throw new FilamentValidationError(`${label} must be at least 0.01.`)
  return rounded
}
export function remainingFromMeasurement(wholeG: number, emptyG: number): number {
  return weight(
    weight(wholeG, 'Whole spool weight') - weight(emptyG, 'Empty spool weight'),
    'Remaining filament',
  )
}
export function combineUsage(rows: FilamentUsageInput[]): FilamentUsageInput[] {
  if (!Array.isArray(rows) || rows.length > 100)
    throw new FilamentValidationError('Use at most 100 spool rows.')
  const combined = new Map<string, number>()
  for (const row of rows) {
    if (
      !row ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.spoolId)
    )
      throw new FilamentValidationError('Choose a valid spool.')
    combined.set(
      row.spoolId,
      weight(
        (combined.get(row.spoolId) ?? 0) + weight(row.grams, 'Filament used'),
        'Filament used',
      ),
    )
  }
  return [...combined].map(([spoolId, grams]) => ({ spoolId, grams }))
}
