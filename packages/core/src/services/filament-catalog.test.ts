import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDb } from '@pb/db'
import { normaliseDataset, writeDataset } from '@pb/filament-catalog'
import { syncFilamentCatalog } from './filament-catalog-sync'
import {
  catalogFacets,
  catalogPicks,
  catalogStatus,
  getCatalogFilament,
  pickerSearch,
  refreshFilamentFromCatalog,
  searchCatalog,
} from './filament-catalog-service'
import { createFilament, editFilament, listFilaments } from './filament-service'
import { prefillFromCatalog, recommendedTemp, type CatalogPick } from './filament-fields'

const url = process.env.DATABASE_URL

/** Fixture uuids: recognisable, and valid for the uuid columns. */
const u = (n: number) => `ca7a0000-0000-4000-8000-${String(n).padStart(12, '0')}`
const BRAND_PRUSA = u(1)
const BRAND_ACME = u(2)
const PETG = u(10)
const PLA = u(11)
const GALAXY = u(20)
const JET = u(21)
const RED = u(22)
const GALAXY_1KG = u(30)
const STORE = u(40)

/** OFD `all.json`-shaped fixture; `without` drops variants to simulate upstream removal. */
function source(options: { without?: string[]; linkUrl?: string } = {}) {
  const variants = [
    {
      uuid: GALAXY,
      id: 'v-galaxy',
      slug: 'galaxy_black',
      filament_id: 'f-petg',
      name: 'Galaxy Black',
      color_hex: '#1A1A1F',
      traits: { glitter: true },
    },
    {
      uuid: JET,
      id: 'v-jet',
      slug: 'jet_black',
      filament_id: 'f-petg',
      name: 'Jet Black',
      color_hex: '#000000',
    },
    {
      uuid: RED,
      id: 'v-red',
      slug: 'red',
      filament_id: 'f-pla',
      name: 'Red',
      color_hex: '#ff0000',
      discontinued: true,
    },
  ].filter((v) => !options.without?.includes(v.uuid))
  const sizes = [
    {
      uuid: GALAXY_1KG,
      id: 's-galaxy',
      variant_id: 'v-galaxy',
      filament_weight: 1000,
      diameter: 1.75,
      empty_spool_weight: 193,
      gtin: '8594173675889',
    },
    { uuid: u(31), id: 's-jet', variant_id: 'v-jet', filament_weight: 1000, diameter: 1.75 },
    { uuid: u(32), id: 's-red', variant_id: 'v-red', filament_weight: 750, diameter: 2.85 },
  ].filter((s) => variants.some((v) => v.id === s.variant_id))
  return {
    version: '2026.01.01',
    generated_at: '2026-01-01T00:00:00Z',
    brands: [
      { uuid: BRAND_PRUSA, id: 'b-prusa', slug: 'prusament', name: 'Prusament' },
      { uuid: BRAND_ACME, id: 'b-acme', slug: 'acme', name: 'Acme' },
    ],
    materials: [
      { uuid: u(50), id: 'm-petg', slug: 'PETG', brand_id: 'b-prusa', material: 'PETG' },
      { uuid: u(51), id: 'm-pla', slug: 'PLA', brand_id: 'b-acme', material: 'PLA' },
    ],
    filaments: [
      {
        uuid: PETG,
        id: 'f-petg',
        slug: 'prusament_petg',
        brand_id: 'b-prusa',
        material_id: 'm-petg',
        name: 'Prusament PETG',
        material: 'PETG',
        min_print_temperature: 240,
        max_print_temperature: 260,
        min_bed_temperature: 70,
        max_bed_temperature: 90,
        dry_temperature: 65,
        dry_time: 4,
        slicer_settings: { prusaslicer: { profile_name: 'Prusament PETG' } },
      },
      {
        uuid: PLA,
        id: 'f-pla',
        slug: 'pla_basic',
        brand_id: 'b-acme',
        material_id: 'm-pla',
        name: 'PLA Basic',
        material: 'PLA',
        min_print_temperature: 200,
        max_print_temperature: 220,
      },
    ],
    variants,
    sizes,
    stores: [
      {
        uuid: STORE,
        id: 'st-shop',
        slug: 'shop',
        name: 'Shop',
        storefront_url: 'https://shop.example/',
      },
    ],
    purchase_links: sizes.some((s) => s.uuid === GALAXY_1KG)
      ? [
          {
            id: `l-${options.linkUrl ?? 'a'}`,
            size_id: 's-galaxy',
            store_id: 'st-shop',
            url: options.linkUrl ?? 'https://shop.example/galaxy',
          },
        ]
      : [],
  }
}

describe('catalogue prefill', () => {
  it('recommends the midpoint of a range, rounded to 5 °C', () => {
    expect(recommendedTemp(240, 260)).toBe(250)
    expect(recommendedTemp(190, 220)).toBe(205)
    expect(recommendedTemp(212, 212)).toBe(210)
    expect(recommendedTemp(null, 60)).toBe(60)
    expect(recommendedTemp(null, null)).toBeNull()
  })

  it('copies a colour and size into filament and spool fields', () => {
    const pick: CatalogPick = {
      variantUuid: GALAXY,
      filamentUuid: PETG,
      brandName: 'Prusament',
      brandLogoPath: null,
      filamentName: 'Prusament PETG',
      material: 'PETG',
      variantName: 'Galaxy Black',
      colorHex: '#1a1a1f',
      minPrintTempC: 240,
      maxPrintTempC: 260,
      minBedTempC: 70,
      maxBedTempC: 90,
      discontinued: false,
      removed: false,
      sizes: [
        {
          uuid: GALAXY_1KG,
          filamentWeightG: 1000,
          diameterMm: 1.75,
          emptySpoolWeightG: 193,
          spoolRefill: false,
          discontinued: false,
        },
      ],
    }
    const { filament, spool } = prefillFromCatalog(pick, GALAXY_1KG)
    expect(filament).toMatchObject({
      name: 'Prusament PETG Galaxy Black',
      brand: 'Prusament',
      material: 'PETG',
      colorName: 'Galaxy Black',
      colorHex: '#1a1a1f',
      diameterMm: 1.75,
      nozzleTempC: 250,
      bedTempC: 80,
      catalogVariantUuid: GALAXY,
    })
    expect(spool).toEqual({ nominalWeightG: 1000, emptyWeightG: 193, catalogSizeUuid: GALAXY_1KG })
    // Brand is prefixed when the product name does not already carry it.
    expect(prefillFromCatalog({ ...pick, filamentName: 'PETG' }).filament.name).toBe(
      'Prusament PETG Galaxy Black',
    )
    expect(prefillFromCatalog(pick).spool).toEqual({})
  })
})

describe('filament catalogue with Postgres', { tags: ['integration'] }, () => {
  let db: ReturnType<typeof createDb>['db']
  let pool: ReturnType<typeof createDb>['pool']
  let dir: string

  /** Writes a bundle for `raw` into its own directory and returns it. */
  async function bundle(name: string, raw: unknown): Promise<string> {
    const out = join(dir, name)
    const { dataset } = normaliseDataset(raw)
    await writeDataset(out, dataset, {
      source: 'open-filament-database',
      sourceRepo: 'https://example.invalid/ofd',
      licence: 'MIT',
      tag: `dataset-v-${name}`,
      datasetVersion: name,
      generatedAt: '2026-01-01T00:00:00Z',
      sourceSha256: 'test',
    })
    return out
  }

  async function clear() {
    await db.execute(sql`TRUNCATE filament_catalog_brands, filament_catalog_stores,
      filament_catalog_materials, filament_catalog_filaments, filament_catalog_variants,
      filament_catalog_sizes, filament_catalog_purchase_links, filament_catalog_meta`)
  }

  beforeAll(async () => {
    ;({ db, pool } = createDb(url))
    dir = await mkdtemp(join(tmpdir(), 'pb-catalogue-'))
    await clear()
  })
  afterAll(async () => {
    // Emptying the meta row makes the worker re-import the real bundle on its next boot.
    await clear()
    await pool.end()
    await rm(dir, { recursive: true, force: true })
  })

  it('imports a bundle once, then does nothing while it is unchanged', async () => {
    const v1 = await bundle('v1', source())
    const first = await syncFilamentCatalog(db, { dataDir: v1 })
    expect(first.imported).toBe(true)
    expect(first.counts).toMatchObject({
      brands: 2,
      filaments: 2,
      variants: 3,
      sizes: 3,
      purchase_links: 1,
    })
    expect((await catalogStatus(db))?.datasetVersion).toBe('v1')

    const again = await syncFilamentCatalog(db, { dataDir: v1 })
    expect(again.imported).toBe(false)
  })

  it('finds products by brand and name, with only the matching colours', async () => {
    const all = await searchCatalog(db, { query: 'prusament petg' })
    expect(all.items.map((i) => i.uuid)).toEqual([PETG])
    expect(all.items[0]!.swatches.map((s) => s.name).sort()).toEqual(['Galaxy Black', 'Jet Black'])

    const galaxy = await searchCatalog(db, { query: 'galaxy black' })
    expect(galaxy.items[0]!.swatches.map((s) => s.uuid)).toEqual([GALAXY])
    expect(galaxy.items[0]!).toMatchObject({ matchedVariants: 1, totalVariants: 2 })

    // Every word must match: one strong word does not carry the rest.
    expect((await searchCatalog(db, { query: 'prusament pla' })).items).toEqual([])
    // Typo tolerance through the trigram fallback.
    expect((await searchCatalog(db, { query: 'prusamnet petg' })).items[0]?.uuid).toBe(PETG)
  })

  it('hides discontinued colours unless asked, and filters by brand and diameter', async () => {
    expect((await searchCatalog(db, { query: 'red' })).items).toEqual([])
    expect(
      (await searchCatalog(db, { query: 'red', includeDiscontinued: true })).items[0]?.uuid,
    ).toBe(PLA)
    expect((await searchCatalog(db, { brandUuid: BRAND_PRUSA })).total).toBe(1)
    expect(
      (await searchCatalog(db, { diameterMm: 2.85, includeDiscontinued: true })).items.map(
        (i) => i.uuid,
      ),
    ).toEqual([PLA])

    const facets = await catalogFacets(db)
    expect(facets.brands.map((b) => b.name)).toEqual(['Acme', 'Prusament'])
    expect(facets.diameters.map((d) => d.value)).toEqual([1.75, 2.85])
  })

  it('returns a full product with sizes and buy links', async () => {
    const detail = await getCatalogFilament(db, PETG)
    expect(detail).toMatchObject({
      name: 'Prusament PETG',
      brand: { name: 'Prusament' },
      dryTempC: 65,
      slicerProfiles: [{ slicer: 'prusaslicer', profile: 'Prusament PETG' }],
    })
    const galaxy = detail!.variants.find((v) => v.uuid === GALAXY)!
    expect(galaxy.traits).toEqual(['glitter'])
    expect(galaxy.sizes[0]).toMatchObject({ emptySpoolWeightG: 193, gtin: '8594173675889' })
    expect(galaxy.sizes[0]!.links[0]).toMatchObject({
      url: 'https://shop.example/galaxy',
      store: { name: 'Shop' },
    })
    expect(await getCatalogFilament(db, 'not-a-uuid')).toBeNull()

    const [pick] = await pickerSearch(db, 'galaxy')
    expect(pick).toMatchObject({ variantUuid: GALAXY, brandName: 'Prusament', removed: false })
    expect(pick!.sizes.map((s) => s.uuid)).toEqual([GALAXY_1KG])
  })

  it('soft-removes what leaves upstream and revives it when it returns', async () => {
    const v2 = await bundle('v2', source({ without: [JET], linkUrl: 'https://shop.example/new' }))
    const result = await syncFilamentCatalog(db, { dataDir: v2 })
    expect(result.removed).toMatchObject({ variants: 1, sizes: 1 })

    // Gone from browsing and search...
    const petg = (await searchCatalog(db, { query: 'prusament petg' })).items[0]!
    expect(petg.swatches.map((s) => s.uuid)).toEqual([GALAXY])
    expect((await pickerSearch(db, 'jet black')).map((p) => p.variantUuid)).not.toContain(JET)
    // ...but still resolvable for filament created from it.
    const [jet] = await catalogPicks(db, [JET])
    expect(jet).toMatchObject({ variantName: 'Jet Black', removed: true })
    expect(
      (await getCatalogFilament(db, PETG))!.variants.find((v) => v.uuid === JET)?.removed,
    ).toBe(true)

    // Purchase links are replaced, not accumulated.
    const links = await db.execute<{ url: string }>(
      sql`SELECT url FROM filament_catalog_purchase_links`,
    )
    expect(links.rows.map((r) => r.url)).toEqual(['https://shop.example/new'])

    const v3 = await bundle('v3', source())
    await syncFilamentCatalog(db, { dataDir: v3 })
    expect((await catalogPicks(db, [JET]))[0]?.removed).toBe(false)
  })

  it('refreshes a linked filament from the catalogue, keeping its name and notes', async () => {
    const [pick] = await catalogPicks(db, [GALAXY])
    const { filament } = prefillFromCatalog(pick!)
    const id = await createFilament(db, filament)
    try {
      await editFilament(db, id, {
        ...filament,
        name: 'My shelf PETG',
        notes: 'Dry box 2',
        colorName: 'Edited',
        nozzleTempC: 230,
      })
      await refreshFilamentFromCatalog(db, id)
      const after = (await listFilaments(db)).find((f) => f.id === id)!
      expect(after).toMatchObject({
        name: 'My shelf PETG',
        notes: 'Dry box 2',
        colorName: 'Galaxy Black',
        nozzleTempC: 250,
        catalogVariantUuid: GALAXY,
      })
    } finally {
      await db.execute(sql`DELETE FROM filaments WHERE id = ${id}`)
    }
  })

  it('serialises concurrent imports so only one does the work', async () => {
    const v4 = await bundle('v4', source({ linkUrl: 'https://shop.example/v4' }))
    const results = await Promise.all([
      syncFilamentCatalog(db, { dataDir: v4 }),
      syncFilamentCatalog(db, { dataDir: v4 }),
    ])
    expect(results.map((r) => r.imported).sort()).toEqual([false, true])
  })
})
