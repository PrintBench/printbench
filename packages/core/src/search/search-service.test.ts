import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDb } from '@pm/db'
import { refreshModelSearchVectors } from './refresh'
import { quickSearch, searchModels } from './search-service'

/**
 * Search behaviour, against a fixture library resembling a real collection.
 *
 * Search is the headline feature, so this doubles as a relevance suite: a set
 * of queries someone would actually type, with the result they would expect.
 * If a change to weighting or matching breaks one of these, it should fail
 * here rather than be discovered by someone who cannot find their dragon.
 */
const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

const LIB_A = '7a000000-0000-4000-8000-00000000000a'
const LIB_B = '7b000000-0000-4000-8000-00000000000b'
const CREATOR_LOOT = '7c000000-0000-4000-8000-00000000000c'
const CREATOR_FUNC = '7d000000-0000-4000-8000-00000000000d'
const TAG_DRAGON = '7e000000-0000-4000-8000-00000000000e'
const TAG_TERRAIN = '7f000000-0000-4000-8000-00000000000f'

describeDb('searchModels', () => {
  let pool: ReturnType<typeof createDb>['pool']
  let db: ReturnType<typeof createDb>['db']

  /** Only this suite's fixtures, so other data in the database cannot skew it. */
  const search = (options: Parameters<typeof searchModels>[1] = {}) =>
    searchModels(db, { ...options, libraryIds: options.libraryIds ?? [LIB_A, LIB_B] })

  const names = async (options: Parameters<typeof searchModels>[1] = {}) =>
    (await search(options)).hits.map((hit) => hit.name)

  beforeAll(async () => {
    ;({ pool, db } = createDb(url))
    await cleanup()

    await db.execute(sql`
      INSERT INTO libraries (id, name, kind, backend, path) VALUES
        (${LIB_A}, 'Miniatures', 'in_place', 'local', '/fixtures/search-a'),
        (${LIB_B}, 'Functional', 'in_place', 'local', '/fixtures/search-b')
    `)
    await db.execute(sql`
      INSERT INTO creators (id, name, slug, public_id) VALUES
        (${CREATOR_LOOT}, 'Loot Studios', 'loot-studios-sx', 'crsx00000001'),
        (${CREATOR_FUNC}, 'Functional Prints', 'functional-prints-sx', 'crsx00000002')
    `)
    await db.execute(sql`
      INSERT INTO tags (id, name, slug) VALUES
        (${TAG_DRAGON}, 'dragon', 'dragon-sx'),
        (${TAG_TERRAIN}, 'terrain', 'terrain-sx')
    `)

    const models: [string, string, string, string | null, string | null, number][] = [
      // id-suffix, library, name, creator, licence, totalSize
      ['01', LIB_A, 'Red Dragon Miniature', CREATOR_LOOT, 'CC-BY-4.0', 40_000_000],
      ['02', LIB_A, 'Blue Dragon Wyrmling', CREATOR_LOOT, 'CC-BY-4.0', 12_000_000],
      ['03', LIB_A, 'Forest Troll', CREATOR_LOOT, 'CC-BY-NC-4.0', 30_000_000],
      ['04', LIB_A, 'Pokémon Gym Playset', null, null, 8_000_000],
      ['05', LIB_B, 'Hinged Storage Box', CREATOR_FUNC, 'MIT', 2_000_000],
      ['06', LIB_B, 'Cable Clip', CREATOR_FUNC, 'MIT', 100_000],
      ['07', LIB_B, 'Benchy', null, null, 3_000_000],
      ['08', LIB_A, 'Stone Bridge Terrain', CREATOR_LOOT, 'CC-BY-4.0', 20_000_000],
      // Named for a word that appears only in other models' notes, so the
      // weighting between name (A) and notes (C) can be tested directly.
      ['09', LIB_A, 'Beast Mount', CREATOR_LOOT, 'CC-BY-4.0', 15_000_000],
    ]

    for (const [suffix, library, name, creator, license, size] of models) {
      await db.execute(sql`
        INSERT INTO models (id, library_id, path, name, slug, public_id, creator_id, license,
                            total_size, file_count, notes)
        VALUES (${modelId(suffix)}, ${library}, ${'fx/' + suffix}, ${name},
                ${'fx-' + suffix}, ${'mdsx0000000' + suffix}, ${creator}, ${license},
                ${size}, 2,
                ${name.includes('Dragon') ? 'A fearsome winged beast for tabletop games' : null})
      `)
    }

    await db.execute(sql`
      INSERT INTO model_tags (model_id, tag_id) VALUES
        (${modelId('01')}, ${TAG_DRAGON}),
        (${modelId('02')}, ${TAG_DRAGON}),
        (${modelId('08')}, ${TAG_TERRAIN}),
        (${modelId('04')}, ${TAG_TERRAIN})
    `)

    // Files, so extension and pre-supported facets have something to work with.
    const files: [string, string, string, boolean, number][] = [
      ['01', 'presupported/body_sup.stl', 'stl', true, 500_000],
      ['01', 'stl/body.stl', 'stl', false, 900_000],
      ['02', 'wyrmling.stl', 'stl', false, 200_000],
      ['03', 'troll.stl', 'stl', false, 800_000],
      ['04', 'gym.3mf', '3mf', false, 300_000],
      ['05', 'box.3mf', '3mf', false, 90_000],
      ['06', 'clip.stl', 'stl', false, 20_000],
      ['07', 'benchy.stl', 'stl', false, 60_000],
      ['08', 'bridge.stl', 'stl', false, 400_000],
      ['09', 'mount.stl', 'stl', false, 350_000],
    ]
    for (const [suffix, filename, extension, presupported, size] of files) {
      await db.execute(sql`
        INSERT INTO model_files (model_id, filename, extension, category, previewable,
                                 presupported, size, media_type)
        VALUES (${modelId(suffix)}, ${filename}, ${extension}, 'model', true,
                ${presupported}, ${size}, ${'model/' + extension})
      `)
    }

    // A print against Benchy, so the never-printed filter has both sides.
    await db.execute(sql`
      INSERT INTO print_runs (model_id, status) VALUES (${modelId('07')}, 'success')
    `)

    await refreshModelSearchVectors(
      db,
      models.map(([suffix]) => modelId(suffix)),
    )
  })

  afterAll(async () => {
    await cleanup()
    await pool.end()
  })

  async function cleanup() {
    await db.execute(sql`DELETE FROM libraries WHERE id IN (${LIB_A}, ${LIB_B})`)
    /*
     * Deleted by NAME as well as id. The unique index on creators is
     * lower(name), so a row left behind by another run collides on insert even
     * though its id differs — which is exactly how this suite started failing
     * once something else in the app created a "Loot Studios".
     */
    await db.execute(sql`
      DELETE FROM creators WHERE id IN (${CREATOR_LOOT}, ${CREATOR_FUNC})
         OR lower(name) IN ('loot studios', 'functional prints')`)
    await db.execute(sql`
      DELETE FROM tags WHERE id IN (${TAG_DRAGON}, ${TAG_TERRAIN})
         OR lower(name) IN ('dragon', 'terrain')`)
  }

  describe('relevance', () => {
    /*
     * Queries a person would actually type, with the result they expect first.
     * These are the assertions most likely to catch a bad weighting change.
     */
    const cases: [string, string][] = [
      ['red dragon', 'Red Dragon Miniature'],
      ['blue dragon', 'Blue Dragon Wyrmling'],
      ['troll', 'Forest Troll'],
      ['benchy', 'Benchy'],
      ['cable clip', 'Cable Clip'],
      ['hinged box', 'Hinged Storage Box'],
      ['bridge', 'Stone Bridge Terrain'],
      ['pokemon', 'Pokémon Gym Playset'],
      ['wyrmling', 'Blue Dragon Wyrmling'],
      ['storage', 'Hinged Storage Box'],
      ['playset', 'Pokémon Gym Playset'],
    ]

    for (const [query, expected] of cases) {
      it(`"${query}" ranks ${expected} first`, async () => {
        const result = await names({ query })
        expect(result[0], `got: ${result.join(', ')}`).toBe(expected)
      })
    }

    it('finds every model matching a general term', async () => {
      // No principled reason either dragon outranks the other, so assert the
      // set rather than an arbitrary order.
      const result = await names({ query: 'dragon' })
      expect(result).toContain('Red Dragon Miniature')
      expect(result).toContain('Blue Dragon Wyrmling')
      expect(result).not.toContain('Cable Clip')
    })

    /*
     * The point of the weighted vector: a term in the NAME must outrank the
     * same term buried in notes. Without weighting, a model merely described as
     * "beast-like" would compete with one actually called Beast.
     */
    it('ranks a name match above a notes-only match', async () => {
      const result = await names({ query: 'beast' })
      expect(result[0], `got: ${result.join(', ')}`).toBe('Beast Mount')
      // The dragons still match, via their notes.
      expect(result).toContain('Red Dragon Miniature')
    })

    it('finds models by creator name', async () => {
      const result = await names({ query: 'loot studios' })
      expect(result).toContain('Red Dragon Miniature')
      expect(result).not.toContain('Cable Clip')
    })

    it('finds models by tag', async () => {
      const result = await names({ query: 'terrain' })
      expect(result).toContain('Stone Bridge Terrain')
      expect(result).toContain('Pokémon Gym Playset')
    })

    it('finds a word inside a filename path', async () => {
      // Only reachable because filenames are split before tokenising.
      const result = await names({ query: 'presupported' })
      expect(result).toEqual(['Red Dragon Miniature'])
    })

    it('folds accents both ways', async () => {
      expect(await names({ query: 'pokemon' })).toContain('Pokémon Gym Playset')
      expect(await names({ query: 'Pokémon' })).toContain('Pokémon Gym Playset')
    })

    it('stems, so singular finds plural', async () => {
      expect(await names({ query: 'game' })).toContain('Red Dragon Miniature')
    })

    it('supports websearch negation', async () => {
      const result = await names({ query: 'dragon -blue' })
      expect(result).toContain('Red Dragon Miniature')
      expect(result).not.toContain('Blue Dragon Wyrmling')
    })

    it('tolerates typos', async () => {
      // Dropped and doubled letters are within trigram reach.
      expect(await names({ query: 'benchi' })).toContain('Benchy')
      expect(await names({ query: 'draggon' })).toContain('Red Dragon Miniature')
    })

    it('matches short fragments that are neither a word nor a near-miss', async () => {
      // "wyrm" is not a stemmed word in the vector and scores poorly on
      // trigrams, so the substring path is what makes it findable.
      expect(await names({ query: 'wyrm' })).toContain('Blue Dragon Wyrmling')
    })

    it('returns nothing for an unrelated query', async () => {
      expect(await names({ query: 'helicopter carburettor' })).toEqual([])
    })

    it('treats wildcards as literal characters', async () => {
      // Without escaping, "%" in an ILIKE pattern would match everything.
      expect(await names({ query: '%' })).toEqual([])
    })
  })

  describe('filters', () => {
    it('filters by library', async () => {
      const result = await names({ libraryIds: [LIB_B] })
      expect(result.sort()).toEqual(['Benchy', 'Cable Clip', 'Hinged Storage Box'])
    })

    it('filters by creator', async () => {
      const result = await names({ creatorIds: [CREATOR_FUNC] })
      expect(result.sort()).toEqual(['Cable Clip', 'Hinged Storage Box'])
    })

    it('filters by library', async () => {
      expect((await names({ libraryIds: [LIB_A] })).length).toBe(6)
    })

    it('filters by licence', async () => {
      expect((await names({ licenses: ['MIT'] })).sort()).toEqual([
        'Cable Clip',
        'Hinged Storage Box',
      ])
    })

    it('filters by file format', async () => {
      expect((await names({ extensions: ['3mf'] })).sort()).toEqual([
        'Hinged Storage Box',
        'Pokémon Gym Playset',
      ])
    })

    it('filters to pre-supported models', async () => {
      expect(await names({ presupported: true })).toEqual(['Red Dragon Miniature'])
    })

    it('narrows as more tags are selected', async () => {
      // One tag matches four models; both together match none, because a model
      // must carry EVERY selected tag.
      expect((await names({ tagIds: [TAG_DRAGON] })).sort()).toEqual([
        'Blue Dragon Wyrmling',
        'Red Dragon Miniature',
      ])
      expect(await names({ tagIds: [TAG_DRAGON, TAG_TERRAIN] })).toEqual([])
    })

    it('filters by size range', async () => {
      const large = await names({ minSize: 25_000_000 })
      expect(large.sort()).toEqual(['Forest Troll', 'Red Dragon Miniature'])
      expect(await names({ maxSize: 200_000 })).toEqual(['Cable Clip'])
    })

    it('filters to models never printed', async () => {
      const result = await names({ neverPrinted: true })
      expect(result).not.toContain('Benchy')
      expect(result).toContain('Red Dragon Miniature')
    })

    it('combines a query with filters', async () => {
      const result = await names({ query: 'dragon', creatorIds: [CREATOR_LOOT], licenses: ['CC-BY-4.0'] })
      expect(result.sort()).toEqual(['Blue Dragon Wyrmling', 'Red Dragon Miniature'])
    })
  })

  describe('facets', () => {
    it('counts every dimension', async () => {
      const { facets } = await search()
      expect(facets.libraries.find((f) => f.label === 'Miniatures')?.count).toBe(6)
      expect(facets.creators.find((f) => f.label === 'Loot Studios')?.count).toBe(5)
      expect(facets.tags.find((f) => f.label === 'dragon')?.count).toBe(2)
      expect(facets.licenses.find((f) => f.label === 'MIT')?.count).toBe(2)
      expect(facets.extensions.find((f) => f.label === 'stl')?.count).toBe(7)
    })

    /*
     * A facet's counts exclude its OWN filter. Ticking one creator must still
     * show how many models the others have, or the list becomes a dead end
     * with every other option reading zero.
     */
    it('excludes a facet from its own filter', async () => {
      const { facets } = await search({ creatorIds: [CREATOR_FUNC] })
      expect(facets.creators.find((f) => f.label === 'Loot Studios')?.count).toBe(5)
      // Other facets DO respect the creator filter.
      expect(facets.licenses.find((f) => f.label === 'CC-BY-4.0')).toBeUndefined()
    })

    it('narrows facets to the current query', async () => {
      const { facets } = await search({ query: 'dragon' })
      expect(facets.tags.find((f) => f.label === 'dragon')?.count).toBe(2)
      expect(facets.tags.find((f) => f.label === 'terrain')).toBeUndefined()
    })
  })

  describe('sorting and paging', () => {
    it('sorts by name, size and age', async () => {
      expect((await names({ sort: 'name' }))[0]).toBe('Beast Mount')
      expect((await names({ sort: 'largest' }))[0]).toBe('Red Dragon Miniature')
      expect((await names({ sort: 'oldest' })).length).toBe(9)
    })

    it('reports a total independent of the page size', async () => {
      const page = await search({ limit: 3 })
      expect(page.hits).toHaveLength(3)
      expect(page.total).toBe(9)
    })

    it('pages without repeating or skipping', async () => {
      const first = await search({ limit: 3, offset: 0, sort: 'name' })
      const second = await search({ limit: 3, offset: 3, sort: 'name' })
      const third = await search({ limit: 3, offset: 6, sort: 'name' })

      const all = [...first.hits, ...second.hits, ...third.hits].map((h) => h.name)
      expect(all).toHaveLength(9)
      expect(new Set(all).size).toBe(9)
    })

    it('returns an empty result rather than failing on a page past the end', async () => {
      const result = await search({ limit: 10, offset: 500 })
      expect(result.hits).toEqual([])
      // The total is unknown from an empty window; the UI shows the last page.
      expect(result.total).toBe(0)
    })
  })

  describe('quickSearch', () => {
    it('returns nothing for an empty query', async () => {
      expect(await quickSearch(db, '   ')).toEqual([])
    })

    it('finds models', async () => {
      const hits = await quickSearch(db, 'dragon')
      expect(hits.some((h) => h.kind === 'model' && h.label === 'Red Dragon Miniature')).toBe(true)
    })

    it('finds creators and tags as well as models', async () => {
      const creators = await quickSearch(db, 'loot')
      expect(creators.some((h) => h.kind === 'creator' && h.label === 'Loot Studios')).toBe(true)

      const tags = await quickSearch(db, 'terrain')
      expect(tags.some((h) => h.kind === 'tag')).toBe(true)
    })

    it('respects the limit', async () => {
      const hits = await quickSearch(db, 'e', 5)
      expect(hits.length).toBeLessThanOrEqual(5)
    })
  })
})

function modelId(suffix: string): string {
  return `7aaa0000-0000-4000-8000-0000000000${suffix}`
}
