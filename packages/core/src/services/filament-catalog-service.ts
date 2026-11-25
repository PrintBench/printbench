import { eq, sql, type SQL } from 'drizzle-orm'
import { schema, type Database } from '@pb/db'
import { applyTrigramThreshold, escapeLike, hasSearchOperators } from '../search/search-service'
import { FilamentValidationError, prefillFromCatalog, type CatalogPick } from './filament-fields'
import { editFilament } from './filament-service'

/*
 * Read side of the bundled filament catalogue (Open Filament Database).
 *
 * Everything here reads Postgres only; the bundle itself is loaded by the
 * worker (filament-catalog-sync.ts). Removed rows — gone from the bundle but
 * kept because owned filament may point at them — are hidden from browsing
 * and search, and still returned by direct lookups, flagged `removed`.
 *
 * Search follows docs/search-notes.md: full text OR `query <% text` trigram
 * (that direction), unless the query uses websearch operators.
 */

export type CatalogDb = Pick<Database, 'execute' | 'select'>

const MAX_QUERY_LENGTH = 200
export const CATALOG_PAGE_SIZE = 48
/** Colours shown on a result card before "+N more". */
const SWATCH_LIMIT = 16

export interface CatalogStatus {
  datasetVersion: string
  sourceTag: string
  generatedAt: string
  importedAt: Date
  counts: Record<string, number>
}

export interface CatalogBrandRef {
  uuid: string
  name: string
  logoPath: string | null
}

export interface CatalogSwatch {
  uuid: string
  name: string
  colorHex: string | null
  colorHexes: string[]
  discontinued: boolean
}

export interface CatalogListItem {
  uuid: string
  name: string
  material: string
  brand: CatalogBrandRef
  minPrintTempC: number | null
  maxPrintTempC: number | null
  minBedTempC: number | null
  maxBedTempC: number | null
  discontinued: boolean
  /** Colours matching the search (all colours when there is no query). */
  matchedVariants: number
  totalVariants: number
  swatches: CatalogSwatch[]
}

export interface CatalogSearchParams {
  query?: string
  brandUuid?: string
  material?: string
  diameterMm?: number
  includeDiscontinued?: boolean
  limit?: number
  offset?: number
}

export interface CatalogSearchResult {
  total: number
  items: CatalogListItem[]
}

export interface CatalogFacets {
  brands: { uuid: string; name: string; count: number }[]
  materials: { value: string; count: number }[]
  diameters: { value: number; count: number }[]
}

export interface CatalogStoreRef {
  uuid: string
  name: string
  storefrontUrl: string | null
  logoPath: string | null
}

export interface CatalogPurchaseLinkView {
  url: string
  spoolRefill: boolean
  affiliate: boolean
  shipsFrom: string[]
  shipsTo: string[]
  store: CatalogStoreRef
}

export interface CatalogSizeView {
  uuid: string
  filamentWeightG: number | null
  diameterMm: number | null
  emptySpoolWeightG: number | null
  spoolCoreDiameterMm: number | null
  spoolRefill: boolean
  articleNumber: string | null
  gtin: string | null
  containerMaterial: string | null
  discontinued: boolean
  links: CatalogPurchaseLinkView[]
}

export interface CatalogVariantView extends CatalogSwatch {
  traits: string[]
  transmissionDistance: number | null
  removed: boolean
  sizes: CatalogSizeView[]
}

export interface CatalogFilamentDetail {
  uuid: string
  name: string
  material: string
  brand: CatalogBrandRef & { website: string | null; origin: string | null }
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
  /** Slicer name → profile name, where upstream gives one. */
  slicerProfiles: { slicer: string; profile: string }[]
  certifications: string[]
  discontinued: boolean
  removed: boolean
  variants: CatalogVariantView[]
}

export async function catalogStatus(db: CatalogDb): Promise<CatalogStatus | null> {
  const [row] = await db.select().from(schema.filamentCatalogMeta)
  if (!row) return null
  return {
    datasetVersion: row.datasetVersion,
    sourceTag: row.sourceTag,
    generatedAt: row.generatedAt,
    importedAt: row.importedAt,
    counts: row.counts,
  }
}

/**
 * Which variants (aliased `v`) match a query.
 *
 * Unlike model search, the fuzzy fallback is applied per word and every word
 * must match. Catalogue text is short and shares words heavily, so matching
 * the whole phrase by trigram let one strong word carry it: "polymaker petg"
 * returned every Polymaker product, ABS and PLA included. Per word, a typo
 * ("prusamnet") is still forgiven, but "petg" has to be there too.
 */
function queryClause(query: string): SQL {
  const fullText = sql`v.search_vector @@ websearch_to_tsquery('pb_search', ${query})`
  if (hasSearchOperators(query)) return fullText
  const words = query
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 8)
  if (!words.length) return fullText
  const perWord = words.map(
    (word) => sql`(v.search_vector @@ plainto_tsquery('pb_search', ${word})
      OR ${word} <% v.search_text
      OR v.search_text ILIKE ${'%' + escapeLike(word) + '%'})`,
  )
  return sql`(${fullText} OR (${sql.join(perWord, sql` AND `)}))`
}

/**
 * Filament products matching a search, each with the colours that matched.
 *
 * Matching happens per colour, so "galaxy black" finds the product and shows
 * just that swatch, while "prusament petg" shows every colour.
 */
export async function searchCatalog(
  db: CatalogDb,
  params: CatalogSearchParams = {},
): Promise<CatalogSearchResult> {
  const query = (params.query ?? '').trim().slice(0, MAX_QUERY_LENGTH)
  const limit = Math.min(Math.max(params.limit ?? CATALOG_PAGE_SIZE, 1), 200)
  const offset = Math.max(params.offset ?? 0, 0)

  const variantWhere: SQL[] = [sql`v.removed_at IS NULL`]
  const filamentWhere: SQL[] = [sql`f.removed_at IS NULL`]
  if (!params.includeDiscontinued) {
    variantWhere.push(sql`NOT v.discontinued`)
    filamentWhere.push(sql`NOT f.discontinued`)
  }
  if (query) {
    await applyTrigramThreshold(db)
    variantWhere.push(queryClause(query))
  }
  if (params.brandUuid) filamentWhere.push(sql`f.brand_uuid = ${params.brandUuid}`)
  if (params.material) filamentWhere.push(sql`f.material = ${params.material}`)
  if (params.diameterMm) {
    variantWhere.push(sql`EXISTS (
      SELECT 1 FROM filament_catalog_sizes s
      WHERE s.variant_uuid = v.uuid AND s.removed_at IS NULL AND s.diameter_mm = ${params.diameterMm})`)
  }
  const score = query
    ? sql`ts_rank_cd(v.search_vector, websearch_to_tsquery('pb_search', ${query}), 32) * 4
          + coalesce(word_similarity(${query}, v.search_text), 0)`
    : sql`0`

  const result = await db.execute<{
    uuid: string
    name: string
    material: string
    brand_uuid: string
    brand_name: string
    brand_logo: string | null
    min_print: number | null
    max_print: number | null
    min_bed: number | null
    max_bed: number | null
    discontinued: boolean
    matched: number
    total_variants: number
    swatches: CatalogSwatch[]
    total: number
  }>(sql`
    WITH matched AS (
      SELECT v.uuid, v.filament_uuid, v.name, v.color_hex, v.color_hexes, v.discontinued,
             ${score} AS score
      FROM filament_catalog_variants v
      WHERE ${sql.join(variantWhere, sql` AND `)}
    )
    SELECT f.uuid, f.name, f.material, f.discontinued,
           f.min_print_temp_c AS min_print, f.max_print_temp_c AS max_print,
           f.min_bed_temp_c AS min_bed, f.max_bed_temp_c AS max_bed,
           b.uuid AS brand_uuid, b.name AS brand_name, b.logo_path AS brand_logo,
           count(*)::int AS matched,
           (SELECT count(*)::int FROM filament_catalog_variants a
             WHERE a.filament_uuid = f.uuid AND a.removed_at IS NULL) AS total_variants,
           (array_agg(json_build_object(
              'uuid', m.uuid, 'name', m.name, 'colorHex', m.color_hex,
              'colorHexes', m.color_hexes, 'discontinued', m.discontinued)
            ORDER BY m.score DESC, m.name))[1:${SWATCH_LIMIT}] AS swatches,
           count(*) OVER ()::int AS total
    FROM matched m
    JOIN filament_catalog_filaments f ON f.uuid = m.filament_uuid
    JOIN filament_catalog_brands b ON b.uuid = f.brand_uuid
    WHERE ${sql.join(filamentWhere, sql` AND `)}
    GROUP BY f.uuid, b.uuid
    ORDER BY max(m.score) DESC, lower(b.name), lower(f.name)
    LIMIT ${limit} OFFSET ${offset}`)

  return {
    total: result.rows[0]?.total ?? 0,
    items: result.rows.map((r) => ({
      uuid: r.uuid,
      name: r.name,
      material: r.material,
      brand: { uuid: r.brand_uuid, name: r.brand_name, logoPath: r.brand_logo },
      minPrintTempC: r.min_print,
      maxPrintTempC: r.max_print,
      minBedTempC: r.min_bed,
      maxBedTempC: r.max_bed,
      discontinued: r.discontinued,
      matchedVariants: r.matched,
      totalVariants: r.total_variants,
      swatches: r.swatches,
    })),
  }
}

/** Brand, material and diameter filters for the browser, counted in live products. */
export async function catalogFacets(db: CatalogDb): Promise<CatalogFacets> {
  const [brands, materials, diameters] = await Promise.all([
    db.execute<{ uuid: string; name: string; count: number }>(sql`
      SELECT b.uuid, b.name, count(f.uuid)::int AS count
      FROM filament_catalog_brands b
      JOIN filament_catalog_filaments f ON f.brand_uuid = b.uuid AND f.removed_at IS NULL
      WHERE b.removed_at IS NULL
      GROUP BY b.uuid ORDER BY lower(b.name)`),
    db.execute<{ value: string; count: number }>(sql`
      SELECT material AS value, count(*)::int AS count
      FROM filament_catalog_filaments WHERE removed_at IS NULL
      GROUP BY material ORDER BY count(*) DESC, material`),
    db.execute<{ value: number; count: number }>(sql`
      SELECT s.diameter_mm AS value, count(DISTINCT v.filament_uuid)::int AS count
      FROM filament_catalog_sizes s
      JOIN filament_catalog_variants v ON v.uuid = s.variant_uuid AND v.removed_at IS NULL
      WHERE s.removed_at IS NULL AND s.diameter_mm IS NOT NULL
      GROUP BY s.diameter_mm ORDER BY s.diameter_mm`),
  ])
  return { brands: brands.rows, materials: materials.rows, diameters: diameters.rows }
}

/** Distinct materials, most common first, for the spool form's suggestions. */
export async function catalogMaterials(db: CatalogDb, limit = 60): Promise<string[]> {
  const rows = await db.execute<{ material: string }>(sql`
    SELECT material FROM filament_catalog_filaments WHERE removed_at IS NULL
    GROUP BY material ORDER BY count(*) DESC, material LIMIT ${limit}`)
  return rows.rows.map((r) => r.material)
}

/** One product with every colour, size and buy link. Removed rows are included and flagged. */
export async function getCatalogFilament(
  db: CatalogDb,
  uuid: string,
): Promise<CatalogFilamentDetail | null> {
  if (!isUuid(uuid)) return null
  const [filament] = await db
    .execute<Record<string, unknown>>(
      sql`
    SELECT f.*, b.name AS brand_name, b.logo_path AS brand_logo, b.website AS brand_website,
           b.origin AS brand_origin
    FROM filament_catalog_filaments f
    JOIN filament_catalog_brands b ON b.uuid = f.brand_uuid
    WHERE f.uuid = ${uuid}`,
    )
    .then((r) => r.rows)
  if (!filament) return null

  const [variants, sizes, links] = await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      SELECT * FROM filament_catalog_variants WHERE filament_uuid = ${uuid}
      ORDER BY removed_at IS NOT NULL, discontinued, lower(name)`),
    db.execute<Record<string, unknown>>(sql`
      SELECT s.* FROM filament_catalog_sizes s
      JOIN filament_catalog_variants v ON v.uuid = s.variant_uuid
      WHERE v.filament_uuid = ${uuid} AND s.removed_at IS NULL
      ORDER BY s.diameter_mm, s.filament_weight_g, s.spool_refill`),
    db.execute<Record<string, unknown>>(sql`
      SELECT l.*, st.name AS store_name, st.storefront_url, st.logo_path AS store_logo
      FROM filament_catalog_purchase_links l
      JOIN filament_catalog_sizes s ON s.uuid = l.size_uuid
      JOIN filament_catalog_variants v ON v.uuid = s.variant_uuid
      JOIN filament_catalog_stores st ON st.uuid = l.store_uuid
      WHERE v.filament_uuid = ${uuid}
      ORDER BY lower(st.name)`),
  ])

  const linksBySize = group(links.rows, 'size_uuid', (l) => ({
    url: l.url as string,
    spoolRefill: l.spool_refill as boolean,
    affiliate: l.affiliate as boolean,
    shipsFrom: l.ships_from as string[],
    shipsTo: l.ships_to as string[],
    store: {
      uuid: l.store_uuid as string,
      name: l.store_name as string,
      storefrontUrl: l.storefront_url as string | null,
      logoPath: l.store_logo as string | null,
    },
  }))
  const sizesByVariant = group(sizes.rows, 'variant_uuid', (s) => ({
    uuid: s.uuid as string,
    filamentWeightG: s.filament_weight_g as number | null,
    diameterMm: s.diameter_mm as number | null,
    emptySpoolWeightG: s.empty_spool_weight_g as number | null,
    spoolCoreDiameterMm: s.spool_core_diameter_mm as number | null,
    spoolRefill: s.spool_refill as boolean,
    articleNumber: s.article_number as string | null,
    gtin: s.gtin as string | null,
    containerMaterial: s.container_material as string | null,
    discontinued: s.discontinued as boolean,
    links: linksBySize.get(s.uuid as string) ?? [],
  }))

  const f = filament
  const n = (key: string) => f[key] as number | null
  return {
    uuid: f.uuid as string,
    name: f.name as string,
    material: f.material as string,
    brand: {
      uuid: f.brand_uuid as string,
      name: f.brand_name as string,
      logoPath: f.brand_logo as string | null,
      website: f.brand_website as string | null,
      origin: f.brand_origin as string | null,
    },
    densityGCm3: n('density_g_cm3'),
    diameterToleranceMm: n('diameter_tolerance_mm'),
    minPrintTempC: n('min_print_temp_c'),
    maxPrintTempC: n('max_print_temp_c'),
    preheatTempC: n('preheat_temp_c'),
    minBedTempC: n('min_bed_temp_c'),
    maxBedTempC: n('max_bed_temp_c'),
    chamberTempC: n('chamber_temp_c'),
    minChamberTempC: n('min_chamber_temp_c'),
    maxChamberTempC: n('max_chamber_temp_c'),
    dryTempC: n('dry_temp_c'),
    dryTimeH: n('dry_time_h'),
    maxDryTempC: n('max_dry_temp_c'),
    enclosure: f.enclosure as string | null,
    minNozzleMm: n('min_nozzle_mm'),
    minPrintSpeedMmS: n('min_print_speed_mm_s'),
    maxPrintSpeedMmS: n('max_print_speed_mm_s'),
    minFanSpeedPct: n('min_fan_speed_pct'),
    maxFanSpeedPct: n('max_fan_speed_pct'),
    maxVolumetricSpeedMm3S: n('max_volumetric_speed_mm3_s'),
    shoreHardnessA: n('shore_hardness_a'),
    shoreHardnessD: n('shore_hardness_d'),
    dataSheetUrl: f.data_sheet_url as string | null,
    safetySheetUrl: f.safety_sheet_url as string | null,
    slicerProfiles: slicerProfiles(f.slicer_settings),
    certifications: f.certifications as string[],
    discontinued: f.discontinued as boolean,
    removed: f.removed_at != null,
    variants: variants.rows.map((v) => ({
      uuid: v.uuid as string,
      name: v.name as string,
      colorHex: v.color_hex as string | null,
      colorHexes: v.color_hexes as string[],
      discontinued: v.discontinued as boolean,
      traits: v.traits as string[],
      transmissionDistance: v.transmission_distance as number | null,
      removed: v.removed_at != null,
      sizes: sizesByVariant.get(v.uuid as string) ?? [],
    })),
  }
}

/** Colours for the spool form's "find in catalogue" box. */
export async function pickerSearch(
  db: CatalogDb,
  rawQuery: string,
  limit = 20,
): Promise<CatalogPick[]> {
  const query = rawQuery.trim().slice(0, MAX_QUERY_LENGTH)
  if (!query) return []
  await applyTrigramThreshold(db)
  const rows = await db.execute<{ uuid: string }>(sql`
    SELECT v.uuid FROM filament_catalog_variants v
    WHERE v.removed_at IS NULL AND ${queryClause(query)}
    ORDER BY v.discontinued,
             ts_rank_cd(v.search_vector, websearch_to_tsquery('pb_search', ${query}), 32) * 4
             + coalesce(word_similarity(${query}, v.search_text), 0) DESC,
             v.search_text
    LIMIT ${Math.min(Math.max(limit, 1), 50)}`)
  return catalogPicks(
    db,
    rows.rows.map((r) => r.uuid),
  )
}

/**
 * Picks for the given colours, in the order given. Removed colours are
 * included (flagged), because owned filament may have been made from one.
 */
export async function catalogPicks(db: CatalogDb, variantUuids: string[]): Promise<CatalogPick[]> {
  const ids = [...new Set(variantUuids.filter(isUuid))]
  if (!ids.length) return []
  const list = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )
  const [variants, sizes] = await Promise.all([
    db.execute<{
      uuid: string
      filament_uuid: string
      name: string
      color_hex: string | null
      discontinued: boolean
      removed: boolean
      filament_name: string
      material: string
      min_print: number | null
      max_print: number | null
      min_bed: number | null
      max_bed: number | null
      brand_name: string
      brand_logo: string | null
    }>(sql`
      SELECT v.uuid, v.filament_uuid, v.name, v.color_hex,
             (v.discontinued OR f.discontinued) AS discontinued,
             (v.removed_at IS NOT NULL OR f.removed_at IS NOT NULL) AS removed,
             f.name AS filament_name, f.material,
             f.min_print_temp_c AS min_print, f.max_print_temp_c AS max_print,
             f.min_bed_temp_c AS min_bed, f.max_bed_temp_c AS max_bed,
             b.name AS brand_name, b.logo_path AS brand_logo
      FROM filament_catalog_variants v
      JOIN filament_catalog_filaments f ON f.uuid = v.filament_uuid
      JOIN filament_catalog_brands b ON b.uuid = f.brand_uuid
      WHERE v.uuid IN (${list})`),
    db.execute<{
      uuid: string
      variant_uuid: string
      filament_weight_g: number | null
      diameter_mm: number | null
      empty_spool_weight_g: number | null
      spool_refill: boolean
      discontinued: boolean
    }>(sql`
      SELECT uuid, variant_uuid, filament_weight_g, diameter_mm, empty_spool_weight_g,
             spool_refill, discontinued
      FROM filament_catalog_sizes
      WHERE variant_uuid IN (${list}) AND removed_at IS NULL
      ORDER BY diameter_mm, filament_weight_g, spool_refill`),
  ])
  const sizesByVariant = group(sizes.rows, 'variant_uuid', (s) => ({
    uuid: s.uuid,
    filamentWeightG: s.filament_weight_g,
    diameterMm: s.diameter_mm,
    emptySpoolWeightG: s.empty_spool_weight_g,
    spoolRefill: s.spool_refill,
    discontinued: s.discontinued,
  }))
  const byUuid = new Map(
    variants.rows.map((v): [string, CatalogPick] => [
      v.uuid,
      {
        variantUuid: v.uuid,
        filamentUuid: v.filament_uuid,
        brandName: v.brand_name,
        brandLogoPath: v.brand_logo,
        filamentName: v.filament_name,
        material: v.material,
        variantName: v.name,
        colorHex: v.color_hex,
        minPrintTempC: v.min_print,
        maxPrintTempC: v.max_print,
        minBedTempC: v.min_bed,
        maxBedTempC: v.max_bed,
        discontinued: v.discontinued,
        removed: v.removed,
        sizes: sizesByVariant.get(v.uuid) ?? [],
      },
    ]),
  )
  return ids.flatMap((id) => byUuid.get(id) ?? [])
}

/**
 * Re-copies a linked filament's values from its catalogue entry — the
 * explicit "refresh" a user asks for; links never update owned filament on
 * their own. The user's display name, notes and diameter are kept: those are
 * the fields people deliberately make their own.
 */
export async function refreshFilamentFromCatalog(db: Database, filamentId: string): Promise<void> {
  const [row] = await db.select().from(schema.filaments).where(eq(schema.filaments.id, filamentId))
  if (!row) throw new FilamentValidationError('That filament no longer exists.')
  if (!row.catalogVariantUuid)
    throw new FilamentValidationError('This filament was not added from the catalogue.')
  const [pick] = await catalogPicks(db, [row.catalogVariantUuid])
  if (!pick) throw new FilamentValidationError('Its catalogue entry is not available.')
  const { filament } = prefillFromCatalog(pick)
  await editFilament(db, filamentId, {
    ...filament,
    name: row.name,
    notes: row.notes,
    diameterMm: Number(row.diameterMm),
  })
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function isUuid(value: string): boolean {
  return UUID.test(value)
}

function group<R extends Record<string, unknown>, T>(
  rows: R[],
  key: keyof R,
  map: (row: R) => T,
): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const row of rows) {
    const k = row[key] as string
    const list = out.get(k) ?? []
    list.push(map(row))
    out.set(k, list)
  }
  return out
}

/** Upstream nests `{ slicer: { profile_name, ... } }`; only the profile names are shown. */
function slicerProfiles(settings: unknown): { slicer: string; profile: string }[] {
  if (!settings || typeof settings !== 'object') return []
  return Object.entries(settings as Record<string, unknown>)
    .flatMap(([slicer, value]) => {
      const profile = (value as { profile_name?: unknown } | null)?.profile_name
      return typeof profile === 'string' && profile ? [{ slicer, profile }] : []
    })
    .sort((a, b) => a.slicer.localeCompare(b.slicer))
}
