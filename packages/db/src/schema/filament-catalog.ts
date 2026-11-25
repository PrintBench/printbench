import {
  boolean,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { tsvector } from './columns'

/*
 * The bundled filament catalogue (Open Filament Database), imported by the
 * worker from packages/filament-catalog/data. See docs/filament-catalog.md.
 *
 * These tables are reference data, not user data:
 * - Keyed by OFD's `uuid`, which survives upstream renames and moves; `ofd_id`
 *   is OFD's path-derived id, kept only for cross-referencing.
 * - Rows are never deleted. One that leaves the dataset gets `removed_at`,
 *   because owned filament may point at it and entries do come back. A row
 *   reappearing clears it again.
 * - `seen_version` is the bundle's content hash at the last import that
 *   contained the row; the import soft-removes everything not seen.
 * - `extra` holds upstream fields PrintBench does not model yet, so a new
 *   upstream field is kept rather than lost, and never breaks an import.
 *
 * References between catalogue tables are indexed but not foreign keys: the
 * import upserts in bulk, and a dangling reference is already refused when the
 * bundle is built.
 */

const catalogColumns = {
  ofdId: text('ofd_id').notNull(),
  extra: jsonb('extra').$type<Record<string, unknown>>().notNull().default({}),
  seenVersion: text('seen_version').notNull(),
  removedAt: timestamp('removed_at', { withTimezone: true }),
}

export const filamentCatalogBrands = pgTable(
  'filament_catalog_brands',
  {
    uuid: uuid('uuid').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    website: text('website'),
    origin: text('origin'),
    parentBrandUuid: uuid('parent_brand_uuid'),
    discontinued: boolean('discontinued').notNull().default(false),
    logoPath: text('logo_path'),
    ...catalogColumns,
  },
  (t) => [index('filament_catalog_brands_name_idx').on(t.name)],
)

export const filamentCatalogStores = pgTable('filament_catalog_stores', {
  uuid: uuid('uuid').primaryKey(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  storefrontUrl: text('storefront_url'),
  shipsFrom: text('ships_from').array().notNull().default([]),
  shipsTo: text('ships_to').array().notNull().default([]),
  logoPath: text('logo_path'),
  ...catalogColumns,
})

export const filamentCatalogMaterials = pgTable(
  'filament_catalog_materials',
  {
    uuid: uuid('uuid').primaryKey(),
    slug: text('slug').notNull(),
    brandUuid: uuid('brand_uuid').notNull(),
    material: text('material').notNull(),
    materialClass: text('material_class'),
    defaultMaxDryTempC: doublePrecision('default_max_dry_temp_c'),
    defaultSlicerSettings: jsonb('default_slicer_settings').$type<Record<string, unknown>>(),
    ...catalogColumns,
  },
  (t) => [index('filament_catalog_materials_brand_idx').on(t.brandUuid)],
)

export const filamentCatalogFilaments = pgTable(
  'filament_catalog_filaments',
  {
    uuid: uuid('uuid').primaryKey(),
    slug: text('slug').notNull(),
    brandUuid: uuid('brand_uuid').notNull(),
    materialUuid: uuid('material_uuid').notNull(),
    name: text('name').notNull(),
    material: text('material').notNull(),
    densityGCm3: doublePrecision('density_g_cm3'),
    diameterToleranceMm: doublePrecision('diameter_tolerance_mm'),
    minPrintTempC: doublePrecision('min_print_temp_c'),
    maxPrintTempC: doublePrecision('max_print_temp_c'),
    preheatTempC: doublePrecision('preheat_temp_c'),
    minBedTempC: doublePrecision('min_bed_temp_c'),
    maxBedTempC: doublePrecision('max_bed_temp_c'),
    chamberTempC: doublePrecision('chamber_temp_c'),
    minChamberTempC: doublePrecision('min_chamber_temp_c'),
    maxChamberTempC: doublePrecision('max_chamber_temp_c'),
    dryTempC: doublePrecision('dry_temp_c'),
    dryTimeH: doublePrecision('dry_time_h'),
    maxDryTempC: doublePrecision('max_dry_temp_c'),
    enclosure: text('enclosure'),
    minNozzleMm: doublePrecision('min_nozzle_mm'),
    minPrintSpeedMmS: doublePrecision('min_print_speed_mm_s'),
    maxPrintSpeedMmS: doublePrecision('max_print_speed_mm_s'),
    minFanSpeedPct: doublePrecision('min_fan_speed_pct'),
    maxFanSpeedPct: doublePrecision('max_fan_speed_pct'),
    maxVolumetricSpeedMm3S: doublePrecision('max_volumetric_speed_mm3_s'),
    shoreHardnessA: doublePrecision('shore_hardness_a'),
    shoreHardnessD: doublePrecision('shore_hardness_d'),
    dataSheetUrl: text('data_sheet_url'),
    safetySheetUrl: text('safety_sheet_url'),
    slicerSettings: jsonb('slicer_settings').$type<Record<string, unknown>>(),
    certifications: text('certifications').array().notNull().default([]),
    discontinued: boolean('discontinued').notNull().default(false),
    ...catalogColumns,
  },
  (t) => [
    index('filament_catalog_filaments_brand_idx').on(t.brandUuid),
    index('filament_catalog_filaments_material_idx').on(t.material),
  ],
)

export const filamentCatalogVariants = pgTable(
  'filament_catalog_variants',
  {
    uuid: uuid('uuid').primaryKey(),
    slug: text('slug').notNull(),
    filamentUuid: uuid('filament_uuid').notNull(),
    name: text('name').notNull(),
    /** Always `#rrggbb` lower case or null: validated when the bundle is built. */
    colorHex: text('color_hex'),
    colorHexes: text('color_hexes').array().notNull().default([]),
    traits: text('traits').array().notNull().default([]),
    transmissionDistance: doublePrecision('transmission_distance'),
    discontinued: boolean('discontinued').notNull().default(false),
    /**
     * Brand, product, material and colour name as one string, written by the
     * import (it needs the parents' names, so it cannot be a generated
     * column). Searched with both full-text and trigram — see
     * docs/search-notes.md.
     */
    searchText: text('search_text').notNull().default(''),
    searchVector: tsvector('search_vector'),
    ...catalogColumns,
  },
  (t) => [
    index('filament_catalog_variants_filament_idx').on(t.filamentUuid),
    index('filament_catalog_variants_search_gin').using('gin', t.searchVector),
    index('filament_catalog_variants_search_trgm').using('gin', t.searchText.op('gin_trgm_ops')),
  ],
)

export const filamentCatalogSizes = pgTable(
  'filament_catalog_sizes',
  {
    uuid: uuid('uuid').primaryKey(),
    variantUuid: uuid('variant_uuid').notNull(),
    filamentWeightG: doublePrecision('filament_weight_g'),
    diameterMm: doublePrecision('diameter_mm'),
    emptySpoolWeightG: doublePrecision('empty_spool_weight_g'),
    spoolCoreDiameterMm: doublePrecision('spool_core_diameter_mm'),
    spoolRefill: boolean('spool_refill').notNull().default(false),
    articleNumber: text('article_number'),
    /** Barcode number, indexed so a scanned spool can be looked up. */
    gtin: text('gtin'),
    containerMaterial: text('container_material'),
    discontinued: boolean('discontinued').notNull().default(false),
    ...catalogColumns,
  },
  (t) => [
    index('filament_catalog_sizes_variant_idx').on(t.variantUuid),
    index('filament_catalog_sizes_gtin_idx').on(t.gtin),
  ],
)

/** Replaced wholesale on each import: nothing links to a purchase link. */
export const filamentCatalogPurchaseLinks = pgTable(
  'filament_catalog_purchase_links',
  {
    ofdId: text('ofd_id').primaryKey(),
    sizeUuid: uuid('size_uuid').notNull(),
    storeUuid: uuid('store_uuid').notNull(),
    url: text('url').notNull(),
    spoolRefill: boolean('spool_refill').notNull().default(false),
    affiliate: boolean('affiliate').notNull().default(false),
    shipsFrom: text('ships_from').array().notNull().default([]),
    shipsTo: text('ships_to').array().notNull().default([]),
  },
  (t) => [index('filament_catalog_purchase_links_size_idx').on(t.sizeUuid)],
)

/** One row: which bundle is in the tables. The import is a no-op while this matches. */
export const filamentCatalogMeta = pgTable('filament_catalog_meta', {
  id: text('id').primaryKey().default('ofd'),
  datasetVersion: text('dataset_version').notNull(),
  sourceTag: text('source_tag').notNull(),
  sourceSha256: text('source_sha256').notNull(),
  contentSha256: text('content_sha256').notNull(),
  generatedAt: text('generated_at').notNull(),
  counts: jsonb('counts').$type<Record<string, number>>().notNull(),
  importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
})
