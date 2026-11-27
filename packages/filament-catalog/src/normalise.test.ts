// @contract filament-catalog/normalise
import { describe, expect, it } from 'vitest'
import { CatalogDataError, normaliseDataset } from './normalise'

/** The smallest dataset with one of everything, in OFD's `all.json` shape. */
function fixture() {
  return {
    version: '2026.01.01',
    generated_at: '2026-01-01T00:00:00Z',
    brands: [
      {
        uuid: 'b-uuid',
        id: 'b-id',
        slug: 'acme',
        name: ' Acme ',
        website: 'https://acme.example/',
        logo_name: 'logo.png',
        origin: 'NL',
        source: 'openprinttag',
      },
    ],
    materials: [
      {
        uuid: 'm-uuid',
        id: 'm-id',
        slug: 'PLA',
        brand_id: 'b-id',
        material: 'PLA',
        material_class: 'FFF',
      },
    ],
    filaments: [
      {
        uuid: 'f-uuid',
        id: 'f-id',
        slug: 'acme_pla',
        brand_id: 'b-id',
        material_id: 'm-id',
        name: 'Acme PLA',
        material: 'PLA',
        density: 1.24,
        min_print_temperature: 190,
        max_print_temperature: 9999,
        data_sheet_url: 'javascript:alert(1)',
        discontinued: false,
        sustainability: { recycled_content: { pct: 100 } },
      },
    ],
    variants: [
      {
        uuid: 'v-uuid',
        id: 'v-id',
        slug: 'red',
        filament_id: 'f-id',
        name: 'Red',
        color_hex: '#FF0000',
        color_hexes: ['#00ff00', 'red; background:url(x)'],
        traits: { silk: true, matte: false },
        discontinued: false,
      },
    ],
    sizes: [
      {
        uuid: 's-uuid',
        id: 's-id',
        variant_id: 'v-id',
        filament_weight: 1000,
        diameter: 1.75,
        empty_spool_weight: 216,
        gtin: '0123456789012',
        discontinued: false,
      },
    ],
    stores: [
      {
        uuid: 'st-uuid',
        id: 'st-id',
        slug: 'shop',
        name: 'Shop',
        storefront_url: 'https://shop.example',
        logo_name: 'logo.png',
        ships_from: ['NL'],
        ships_to: [],
      },
    ],
    purchase_links: [
      { id: 'l1', size_id: 's-id', store_id: 'st-id', url: 'https://shop.example/red' },
      { id: 'l2', size_id: 's-id', store_id: 'st-id', url: 'ftp://shop.example/red' },
    ],
  }
}

describe('normaliseDataset', () => {
  it('translates OFD ids to stable uuids for every parent reference', () => {
    const { dataset } = normaliseDataset(fixture())
    expect(dataset.materials[0]!.brandUuid).toBe('b-uuid')
    expect(dataset.filaments[0]).toMatchObject({
      brandUuid: 'b-uuid',
      materialUuid: 'm-uuid',
      ofdId: 'f-id',
    })
    expect(dataset.variants[0]!.filamentUuid).toBe('f-uuid')
    expect(dataset.sizes[0]!.variantUuid).toBe('v-uuid')
    expect(dataset.purchase_links[0]).toMatchObject({ sizeUuid: 's-uuid', storeUuid: 'st-uuid' })
  })

  it('drops values that would be unsafe or nonsensical in the browser', () => {
    const { dataset, dropped } = normaliseDataset(fixture())
    const filament = dataset.filaments[0]!
    expect(filament.dataSheetUrl).toBeNull()
    expect(filament.maxPrintTempC).toBeNull()
    expect(filament.minPrintTempC).toBe(190)

    const variant = dataset.variants[0]!
    expect(variant.colorHex).toBe('#ff0000')
    expect(variant.colorHexes).toEqual(['#00ff00'])

    // A non-http purchase link is dropped entirely.
    expect(dataset.purchase_links.map((l) => l.ofdId)).toEqual(['l1'])
    expect(dropped).toMatchObject({
      'temperature out of range': 1,
      'filament.data_sheet not an http(s) URL': 1,
      'colour not #rrggbb': 1,
      'purchase_link.url not an http(s) URL': 1,
    })
  })

  it('keeps only true traits, and carries unknown fields into extra', () => {
    const { dataset } = normaliseDataset(fixture())
    expect(dataset.variants[0]!.traits).toEqual(['silk'])
    expect(dataset.filaments[0]!.extra).toEqual({
      sustainability: { recycled_content: { pct: 100 } },
    })
    expect(dataset.brands[0]!.extra).toEqual({ source: 'openprinttag' })
    expect(dataset.brands[0]!.name).toBe('Acme')
  })

  it('attaches bundled logo paths', () => {
    const { dataset } = normaliseDataset(fixture(), {
      brandLogos: new Map([['b-uuid', '/filament-catalog/brands/b-uuid.webp']]),
    })
    expect(dataset.brands[0]!.logoPath).toBe('/filament-catalog/brands/b-uuid.webp')
    expect(dataset.stores[0]!.logoPath).toBeNull()
  })

  it('sorts rows by key so two runs write identical files', () => {
    const data = fixture()
    data.variants.push({ ...data.variants[0]!, uuid: 'a-uuid', id: 'v-id-2', slug: 'blue' })
    const { dataset } = normaliseDataset(data)
    expect(dataset.variants.map((v) => v.uuid)).toEqual(['a-uuid', 'v-uuid'])
  })

  it('refuses dangling references and duplicate uuids', () => {
    const dangling = fixture()
    dangling.variants[0]!.filament_id = 'missing'
    expect(() => normaliseDataset(dangling)).toThrow(CatalogDataError)

    const duplicate = fixture()
    duplicate.variants.push({ ...duplicate.variants[0]!, id: 'other-id' })
    expect(() => normaliseDataset(duplicate)).toThrow(/duplicate variants uuid/)
  })

  it('refuses a field that changed type upstream', () => {
    const data = fixture() as any
    data.filaments[0].density = '1.24'
    expect(() => normaliseDataset(data)).toThrow(/filaments\.0\.density/)
  })
})
