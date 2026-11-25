import type {
  CatalogBrand,
  CatalogDataset,
  CatalogFilament,
  CatalogMaterial,
  CatalogPurchaseLink,
  CatalogSize,
  CatalogStore,
  CatalogVariant,
  Json,
} from './rows'
import { sourceDataset, type SourceDataset } from './source-schema'

/*
 * Turns OFD's `all.json` into PrintBench's row shapes.
 *
 * This runs in the maintainer's update script, never at runtime, so it can
 * afford to be thorough: it resolves every parent reference, refuses
 * duplicates and dangling references, and cleans the values that end up in
 * the browser. Community data is untrusted input — a link is rendered as an
 * href and a colour goes straight into a style attribute.
 */

export class CatalogDataError extends Error {
  override name = 'CatalogDataError'
}

export interface NormaliseOptions {
  /** Brand uuids that have a bundled logo, mapped to its public path. */
  brandLogos?: ReadonlyMap<string, string>
  storeLogos?: ReadonlyMap<string, string>
}

export interface NormaliseResult {
  dataset: CatalogDataset
  /** Values that were dropped because they failed a sanity check, by reason. */
  dropped: Record<string, number>
}

const HEX = /^#[0-9a-f]{6}$/

/** Keys mapped to typed columns (or ids we translate), so they stay out of `extra`. */
const KNOWN = {
  brands: [
    'uuid',
    'id',
    'slug',
    'name',
    'website',
    'logo_name',
    'origin',
    'discontinued',
    'parent_brand_id',
    'parent_brand',
  ],
  materials: [
    'uuid',
    'id',
    'slug',
    'brand_id',
    'material',
    'material_class',
    'default_max_dry_temperature',
    'default_slicer_settings',
  ],
  filaments: [
    'uuid',
    'id',
    'slug',
    'brand_id',
    'material_id',
    'name',
    'material',
    'density',
    'diameter_tolerance',
    'min_print_temperature',
    'max_print_temperature',
    'preheat_temperature',
    'min_bed_temperature',
    'max_bed_temperature',
    'chamber_temperature',
    'min_chamber_temperature',
    'max_chamber_temperature',
    'dry_temperature',
    'dry_time',
    'max_dry_temperature',
    'enclosure',
    'min_nozzle_diameter',
    'min_print_speed',
    'max_print_speed',
    'min_fan_speed',
    'max_fan_speed',
    'max_volumetric_speed',
    'shore_hardness_a',
    'shore_hardness_d',
    'data_sheet_url',
    'safety_sheet_url',
    'slicer_settings',
    'certifications',
    'discontinued',
  ],
  variants: [
    'uuid',
    'id',
    'slug',
    'filament_id',
    'name',
    'color_hex',
    'color_hexes',
    'traits',
    'transmission_distance',
    'discontinued',
  ],
  sizes: [
    'uuid',
    'id',
    'variant_id',
    'filament_weight',
    'diameter',
    'empty_spool_weight',
    'spool_core_diameter',
    'spool_refill',
    'article_number',
    'gtin',
    'container_material',
    'discontinued',
  ],
  stores: ['uuid', 'id', 'slug', 'name', 'storefront_url', 'logo_name', 'ships_from', 'ships_to'],
} as const

/** Validates and normalises a parsed `all.json`. Throws `CatalogDataError` on structural problems. */
export function normaliseDataset(raw: unknown, options: NormaliseOptions = {}): NormaliseResult {
  const parsed = sourceDataset.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 10)
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new CatalogDataError(`all.json does not match the expected shape:\n${issues}`)
  }
  return new Normaliser(parsed.data, options).run()
}

class Normaliser {
  private dropped: Record<string, number> = {}

  constructor(
    private src: SourceDataset,
    private options: NormaliseOptions,
  ) {}

  run(): NormaliseResult {
    const { src } = this
    const brandUuid = uuidIndex('brands', src.brands)
    const storeUuid = uuidIndex('stores', src.stores)
    const materialUuid = uuidIndex('materials', src.materials)
    const filamentUuid = uuidIndex('filaments', src.filaments)
    const variantUuid = uuidIndex('variants', src.variants)
    const sizeUuid = uuidIndex('sizes', src.sizes)

    const brands = src.brands.map((b): CatalogBrand => ({
      uuid: b.uuid,
      ofdId: b.id,
      slug: b.slug,
      name: b.name.trim(),
      website: this.url(b.website, 'brand.website'),
      origin: cleanText(b.origin),
      parentBrandUuid: b.parent_brand_id ? ref(brandUuid, b.parent_brand_id, 'brand.parent') : null,
      discontinued: b.discontinued === true,
      logoPath: this.options.brandLogos?.get(b.uuid) ?? null,
      extra: extra(b, KNOWN.brands),
    }))

    const stores = src.stores.map((s): CatalogStore => ({
      uuid: s.uuid,
      ofdId: s.id,
      slug: s.slug,
      name: s.name.trim(),
      storefrontUrl: this.url(s.storefront_url, 'store.url'),
      shipsFrom: s.ships_from ?? [],
      shipsTo: s.ships_to ?? [],
      logoPath: this.options.storeLogos?.get(s.uuid) ?? null,
      extra: extra(s, KNOWN.stores),
    }))

    const materials = src.materials.map((m): CatalogMaterial => ({
      uuid: m.uuid,
      ofdId: m.id,
      slug: m.slug,
      brandUuid: ref(brandUuid, m.brand_id, 'material.brand'),
      material: m.material.trim(),
      materialClass: cleanText(m.material_class),
      defaultMaxDryTempC: this.range(m.default_max_dry_temperature, 20, 200, 'temperature'),
      defaultSlicerSettings: m.default_slicer_settings ?? null,
      extra: extra(m, KNOWN.materials),
    }))

    const filaments = src.filaments.map((f): CatalogFilament => {
      const temp = (v: number | null | undefined) => this.range(v, 0, 600, 'temperature')
      return {
        uuid: f.uuid,
        ofdId: f.id,
        slug: f.slug,
        brandUuid: ref(brandUuid, f.brand_id, 'filament.brand'),
        materialUuid: ref(materialUuid, f.material_id, 'filament.material'),
        name: f.name.trim(),
        material: f.material.trim(),
        densityGCm3: this.range(f.density, 0.1, 25, 'density'),
        diameterToleranceMm: this.range(f.diameter_tolerance, 0, 1, 'tolerance'),
        minPrintTempC: temp(f.min_print_temperature),
        maxPrintTempC: temp(f.max_print_temperature),
        preheatTempC: temp(f.preheat_temperature),
        minBedTempC: temp(f.min_bed_temperature),
        maxBedTempC: temp(f.max_bed_temperature),
        chamberTempC: temp(f.chamber_temperature),
        minChamberTempC: temp(f.min_chamber_temperature),
        maxChamberTempC: temp(f.max_chamber_temperature),
        dryTempC: temp(f.dry_temperature),
        dryTimeH: this.range(f.dry_time, 0, 240, 'duration'),
        maxDryTempC: temp(f.max_dry_temperature),
        enclosure: cleanText(f.enclosure),
        minNozzleMm: this.range(f.min_nozzle_diameter, 0.05, 5, 'nozzle'),
        minPrintSpeedMmS: this.range(f.min_print_speed, 0, 2000, 'speed'),
        maxPrintSpeedMmS: this.range(f.max_print_speed, 0, 2000, 'speed'),
        minFanSpeedPct: this.range(f.min_fan_speed, 0, 100, 'fan'),
        maxFanSpeedPct: this.range(f.max_fan_speed, 0, 100, 'fan'),
        maxVolumetricSpeedMm3S: this.range(f.max_volumetric_speed, 0, 500, 'speed'),
        shoreHardnessA: this.range(f.shore_hardness_a, 0, 100, 'hardness'),
        shoreHardnessD: this.range(f.shore_hardness_d, 0, 100, 'hardness'),
        dataSheetUrl: this.url(f.data_sheet_url, 'filament.data_sheet'),
        safetySheetUrl: this.url(f.safety_sheet_url, 'filament.safety_sheet'),
        slicerSettings: f.slicer_settings ?? null,
        certifications: f.certifications ?? [],
        discontinued: f.discontinued === true,
        extra: extra(f, KNOWN.filaments),
      }
    })

    const variants = src.variants.map((v): CatalogVariant => ({
      uuid: v.uuid,
      ofdId: v.id,
      slug: v.slug,
      filamentUuid: ref(filamentUuid, v.filament_id, 'variant.filament'),
      name: v.name.trim(),
      colorHex: this.hex(v.color_hex),
      colorHexes: (v.color_hexes ?? [])
        .map((h) => this.hex(h))
        .filter((h): h is string => h !== null),
      traits: Object.entries(v.traits ?? {})
        .filter(([, on]) => on === true)
        .map(([name]) => name)
        .sort(),
      transmissionDistance: this.range(v.transmission_distance, 0, 1000, 'transmission'),
      discontinued: v.discontinued === true,
      extra: extra(v, KNOWN.variants),
    }))

    const sizes = src.sizes.map((s): CatalogSize => ({
      uuid: s.uuid,
      ofdId: s.id,
      variantUuid: ref(variantUuid, s.variant_id, 'size.variant'),
      filamentWeightG: this.range(s.filament_weight, 1, 100_000, 'weight'),
      diameterMm: this.range(s.diameter, 0.5, 5, 'diameter'),
      emptySpoolWeightG: this.range(s.empty_spool_weight, 0, 10_000, 'weight'),
      spoolCoreDiameterMm: this.range(s.spool_core_diameter, 0, 1000, 'diameter'),
      spoolRefill: s.spool_refill === true,
      articleNumber: cleanText(s.article_number),
      gtin: this.gtin(s.gtin),
      containerMaterial: cleanText(s.container_material),
      discontinued: s.discontinued === true,
      extra: extra(s, KNOWN.sizes),
    }))

    // A link whose URL fails the scheme check is useless, so the whole link goes.
    const purchaseLinks = src.purchase_links.flatMap((l): CatalogPurchaseLink[] => {
      const url = this.url(l.url, 'purchase_link.url')
      if (!url) return []
      return [
        {
          ofdId: l.id,
          sizeUuid: ref(sizeUuid, l.size_id, 'purchase_link.size'),
          storeUuid: ref(storeUuid, l.store_id, 'purchase_link.store'),
          url,
          spoolRefill: l.spool_refill === true,
          affiliate: l.affiliate === true,
          shipsFrom: l.ships_from ?? [],
          shipsTo: l.ships_to ?? [],
        },
      ]
    })
    unique(
      'purchase_links',
      purchaseLinks.map((l) => l.ofdId),
    )

    const byUuid = <T extends { uuid: string }>(rows: T[]) =>
      rows.sort((a, b) => compare(a.uuid, b.uuid))
    return {
      dataset: {
        brands: byUuid(brands),
        stores: byUuid(stores),
        materials: byUuid(materials),
        filaments: byUuid(filaments),
        variants: byUuid(variants),
        sizes: byUuid(sizes),
        purchase_links: purchaseLinks.sort((a, b) => compare(a.ofdId, b.ofdId)),
      },
      dropped: this.dropped,
    }
  }

  private drop(reason: string): null {
    this.dropped[reason] = (this.dropped[reason] ?? 0) + 1
    return null
  }

  private range(
    v: number | null | undefined,
    min: number,
    max: number,
    what: string,
  ): number | null {
    if (v === null || v === undefined) return null
    if (!Number.isFinite(v) || v < min || v > max) return this.drop(`${what} out of range`)
    return v
  }

  /** Only http(s) survives: these become hrefs, and `javascript:` must never reach one. */
  private url(v: string | null | undefined, what: string): string | null {
    const value = cleanText(v)
    if (!value) return null
    try {
      const parsed = new URL(value)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href
    } catch {
      // fall through
    }
    return this.drop(`${what} not an http(s) URL`)
  }

  private hex(v: string | null | undefined): string | null {
    const value = cleanText(v)?.toLowerCase()
    if (!value) return null
    return HEX.test(value) ? value : this.drop('colour not #rrggbb')
  }

  private gtin(v: string | null | undefined): string | null {
    const value = cleanText(v)
    if (!value) return null
    return /^\d{8,14}$/.test(value) ? value : this.drop('gtin not 8-14 digits')
  }
}

function uuidIndex(entity: string, rows: { id: string; uuid: string }[]): Map<string, string> {
  unique(
    `${entity} uuid`,
    rows.map((r) => r.uuid),
  )
  unique(
    `${entity} id`,
    rows.map((r) => r.id),
  )
  return new Map(rows.map((r) => [r.id, r.uuid]))
}

function unique(what: string, values: string[]): void {
  const seen = new Set<string>()
  for (const v of values) {
    if (seen.has(v)) throw new CatalogDataError(`duplicate ${what}: ${v}`)
    seen.add(v)
  }
}

function ref(index: Map<string, string>, id: string, what: string): string {
  const uuid = index.get(id)
  if (!uuid) throw new CatalogDataError(`${what} refers to unknown id ${id}`)
  return uuid
}

function cleanText(v: string | null | undefined): string | null {
  const value = v?.trim()
  return value ? value : null
}

function extra(record: Record<string, unknown>, known: readonly string[]): Json {
  const out: Json = {}
  for (const key of Object.keys(record).sort()) {
    if (!known.includes(key) && record[key] !== undefined) out[key] = record[key]
  }
  return out
}

/** Locale-independent, so two machines write byte-identical files. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
