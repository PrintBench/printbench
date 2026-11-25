/*
 * The catalogue as PrintBench stores it: one row type per entity, keyed by
 * OFD's `uuid`.
 *
 * Why `uuid` and not OFD's `id`: `id` is derived from the record's path, so it
 * changes when a record is moved or a parent is renamed. Comparing two
 * releases ten weeks apart, 2,788 spool sizes kept their `uuid` but changed
 * `id`. Owned filament links to these rows, so the key has to be the stable
 * one. `ofdId` is kept for cross-referencing OFD's own API.
 *
 * Parent references are already translated from OFD ids to uuids, so the
 * importer never needs the whole dataset in memory to resolve them.
 */

export type Json = Record<string, unknown>

export interface CatalogBrand {
  uuid: string
  ofdId: string
  slug: string
  name: string
  website: string | null
  origin: string | null
  parentBrandUuid: string | null
  discontinued: boolean
  /** Public path of the downscaled logo, when one was bundled. */
  logoPath: string | null
  extra: Json
}

export interface CatalogMaterial {
  uuid: string
  ofdId: string
  slug: string
  brandUuid: string
  material: string
  materialClass: string | null
  defaultMaxDryTempC: number | null
  defaultSlicerSettings: Json | null
  extra: Json
}

export interface CatalogFilament {
  uuid: string
  ofdId: string
  slug: string
  brandUuid: string
  materialUuid: string
  name: string
  material: string
  densityGCm3: number | null
  diameterToleranceMm: number | null
  minPrintTempC: number | null
  maxPrintTempC: number | null
  preheatTempC: number | null
  minBedTempC: number | null
  maxBedTempC: number | null
  chamberTempC: number | null
  minChamberTempC: number | null
  maxChamberTempC: number | null
  dryTempC: number | null
  dryTimeH: number | null
  maxDryTempC: number | null
  /** `not_needed`, `recommended` or `required` upstream; kept as text. */
  enclosure: string | null
  minNozzleMm: number | null
  minPrintSpeedMmS: number | null
  maxPrintSpeedMmS: number | null
  minFanSpeedPct: number | null
  maxFanSpeedPct: number | null
  maxVolumetricSpeedMm3S: number | null
  shoreHardnessA: number | null
  shoreHardnessD: number | null
  dataSheetUrl: string | null
  safetySheetUrl: string | null
  slicerSettings: Json | null
  certifications: string[]
  discontinued: boolean
  extra: Json
}

export interface CatalogVariant {
  uuid: string
  ofdId: string
  slug: string
  filamentUuid: string
  name: string
  /** Always `#rrggbb`, lower case, or null — safe to put in a style attribute. */
  colorHex: string | null
  /** Extra colours for multi-colour filament, same format as `colorHex`. */
  colorHexes: string[]
  /** Trait names whose value is true upstream: `silk`, `matte`, `abrasive`... */
  traits: string[]
  transmissionDistance: number | null
  discontinued: boolean
  extra: Json
}

export interface CatalogSize {
  uuid: string
  ofdId: string
  variantUuid: string
  filamentWeightG: number | null
  diameterMm: number | null
  emptySpoolWeightG: number | null
  spoolCoreDiameterMm: number | null
  spoolRefill: boolean
  articleNumber: string | null
  gtin: string | null
  containerMaterial: string | null
  discontinued: boolean
  extra: Json
}

export interface CatalogStore {
  uuid: string
  ofdId: string
  slug: string
  name: string
  storefrontUrl: string | null
  shipsFrom: string[]
  shipsTo: string[]
  logoPath: string | null
  extra: Json
}

/** Purchase links have no `uuid` upstream; nothing links to them, so OFD's id is enough. */
export interface CatalogPurchaseLink {
  ofdId: string
  sizeUuid: string
  storeUuid: string
  url: string
  spoolRefill: boolean
  affiliate: boolean
  shipsFrom: string[]
  shipsTo: string[]
}

export interface CatalogRows {
  brands: CatalogBrand
  materials: CatalogMaterial
  filaments: CatalogFilament
  variants: CatalogVariant
  sizes: CatalogSize
  stores: CatalogStore
  purchase_links: CatalogPurchaseLink
}

export type CatalogEntity = keyof CatalogRows

/** Parent-before-child order: the order files are written, verified and imported in. */
export const CATALOG_ENTITIES = [
  'brands',
  'stores',
  'materials',
  'filaments',
  'variants',
  'sizes',
  'purchase_links',
] as const satisfies readonly CatalogEntity[]

export type CatalogDataset = { [E in CatalogEntity]: CatalogRows[E][] }

export type CatalogCounts = Record<CatalogEntity, number>

/** `snapshot.json`: what was bundled, from where. */
export interface CatalogSnapshot {
  source: 'open-filament-database'
  sourceRepo: string
  licence: 'MIT'
  /** The GitHub release tag the data came from, e.g. `dataset-v2026.11.23`. */
  tag: string
  datasetVersion: string
  generatedAt: string
  /** sha256 of the upstream `all.json.gz`, checked against the release manifest. */
  sourceSha256: string
  /**
   * sha256 over the bundled NDJSON files, in `CATALOG_ENTITIES` order. The
   * importer keys on this rather than the dataset version, so a change to how
   * PrintBench normalises the same upstream data is still re-imported.
   */
  contentSha256: string
  counts: CatalogCounts
}
