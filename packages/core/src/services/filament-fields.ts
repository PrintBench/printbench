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
  /** The catalogue colour this was filled in from; provenance only. */
  catalogVariantUuid?: string | null
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
  /** The catalogue spool size this roll matches; provenance only. */
  catalogSizeUuid?: string | null
}

/** A catalogue colour as the spool form's picker sees it. */
export interface CatalogPick {
  variantUuid: string
  filamentUuid: string
  brandName: string
  brandLogoPath: string | null
  filamentName: string
  material: string
  variantName: string
  colorHex: string | null
  minPrintTempC: number | null
  maxPrintTempC: number | null
  minBedTempC: number | null
  maxBedTempC: number | null
  discontinued: boolean
  /** Gone from the bundled catalogue; still shown for filament created from it. */
  removed: boolean
  sizes: CatalogPickSize[]
}
export interface CatalogPickSize {
  uuid: string
  filamentWeightG: number | null
  diameterMm: number | null
  emptySpoolWeightG: number | null
  spoolRefill: boolean
  discontinued: boolean
}

/**
 * The recommended temperature for a catalogue range: its midpoint, rounded to
 * 5 °C, because that is how people actually set a nozzle. One bound alone is
 * used as is.
 */
export function recommendedTemp(min: number | null, max: number | null): number | null {
  const value = min != null && max != null ? (min + max) / 2 : (min ?? max)
  if (value == null) return null
  const rounded = Math.round(value / 5) * 5
  return Math.min(500, Math.max(0, rounded))
}

/**
 * Filament (and, with a size, spool) fields filled in from a catalogue entry.
 * A starting point the user can edit: catalogue values are copied, not live.
 */
export function prefillFromCatalog(
  pick: CatalogPick,
  sizeUuid?: string | null,
): { filament: FilamentInput; spool: Partial<SpoolInput> } {
  const size = pick.sizes.find((s) => s.uuid === sizeUuid) ?? null
  const diameter = size?.diameterMm ?? pick.sizes.find((s) => s.diameterMm)?.diameterMm ?? 1.75
  // The brand prefix is dropped when the product name already starts with it
  // ("Prusament PLA" by Prusament), so the display name is not doubled.
  const name = pick.filamentName.toLowerCase().startsWith(pick.brandName.toLowerCase())
    ? `${pick.filamentName} ${pick.variantName}`
    : `${pick.brandName} ${pick.filamentName} ${pick.variantName}`
  return {
    filament: {
      name,
      material: pick.material,
      brand: pick.brandName,
      colorName: pick.variantName,
      colorHex: pick.colorHex,
      diameterMm: diameter,
      nozzleTempC: recommendedTemp(pick.minPrintTempC, pick.maxPrintTempC),
      bedTempC: recommendedTemp(pick.minBedTempC, pick.maxBedTempC),
      catalogVariantUuid: pick.variantUuid,
    },
    spool: size
      ? {
          nominalWeightG: size.filamentWeightG ?? undefined,
          emptyWeightG: size.emptySpoolWeightG,
          catalogSizeUuid: size.uuid,
        }
      : {},
  }
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
