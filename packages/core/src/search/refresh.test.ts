import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDb } from '@pb/db'
import { refreshModelSearchVectors } from './refresh'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

const LIB = '11111111-1111-1111-1111-1111111111aa'
const CREATOR = '22222222-2222-2222-2222-2222222222aa'
const TAG = '33333333-3333-3333-3333-3333333333aa'
const DRAGON = '44444444-4444-4444-4444-4444444444aa'
const BOX = '55555555-5555-5555-5555-5555555555aa'

describeDb('refreshModelSearchVectors', () => {
  // Built in beforeAll, not here: vitest still evaluates the body of a skipped
  // describe, so constructing the pool at collection time would throw when
  // DATABASE_URL is unset.
  let pool: ReturnType<typeof createDb>['pool']
  let db: ReturnType<typeof createDb>['db']

  /*
   * Every query is scoped to this test's own library.
   *
   * Without that these assertions depend on whatever else happens to be in the
   * database — they passed only while it was empty, and started failing the
   * moment a real library was indexed alongside them.
   */
  async function search(query: string): Promise<string[]> {
    const res = await db.execute<{ name: string }>(sql`
      SELECT name FROM models
      WHERE library_id = ${LIB}
        AND search_vector @@ websearch_to_tsquery('pb_search', ${query})
      ORDER BY ts_rank_cd(search_vector, websearch_to_tsquery('pb_search', ${query}), 32) DESC
    `)
    return res.rows.map((r) => r.name)
  }

  /** Typo-tolerant lookup. `<%` is word_similarity(query, target); `%>` is reversed. */
  async function fuzzy(query: string): Promise<string[]> {
    const res = await db.execute<{ name: string }>(sql`
      SELECT name FROM models
      WHERE library_id = ${LIB} AND ${query} <% name
      ORDER BY word_similarity(${query}, name) DESC
    `)
    return res.rows.map((r) => r.name)
  }

  /**
   * Removes this suite's fixtures, including by name.
   *
   * The unique index on creators is lower(name), so an id-only delete leaves a
   * colliding row behind. Run before inserting as well as after: a run that
   * dies partway — the database going away mid-suite, say — never reaches its
   * teardown, and every later run would then fail on the residue rather than
   * on anything real.
   */
  async function cleanup() {
    await db.execute(sql`DELETE FROM models WHERE library_id = ${LIB}`)
    await db.execute(sql`DELETE FROM tags WHERE id = ${TAG} OR lower(name) = 'pokémon'`)
    await db.execute(sql`
      DELETE FROM creators WHERE id = ${CREATOR} OR lower(name) = 'loot studios'`)
    await db.execute(sql`DELETE FROM libraries WHERE id = ${LIB}`)
  }

  beforeAll(async () => {
    ;({ pool, db } = createDb(url))
    await cleanup()
    await db.execute(sql`SET pg_trgm.word_similarity_threshold = 0.5`)
    await db.execute(sql`
      INSERT INTO libraries (id, name, backend, path)
      VALUES (${LIB}, 'Search Fixture', 'local', '/libraries/search-fixture')
    `)
    await db.execute(sql`
      INSERT INTO creators (id, name, slug, public_id)
      VALUES (${CREATOR}, 'Loot Studios', 'loot-studios-fx', 'cr000000fx01')
    `)
    await db.execute(sql`INSERT INTO tags (id, name, slug) VALUES (${TAG}, 'Pokémon', 'pokemon-fx')`)
    await db.execute(sql`
      INSERT INTO models (id, library_id, path, name, slug, public_id, creator_id, notes) VALUES
        (${DRAGON}, ${LIB}, 'fx/red-dragon', 'Red Dragon Miniature', 'red-dragon-fx', 'md000000fx01',
         ${CREATOR}, 'A fearsome winged beast for tabletop games'),
        (${BOX},    ${LIB}, 'fx/hinged-box', 'Hinged Storage Box',   'hinged-box-fx', 'md000000fx02',
         NULL, 'Print in place box')
    `)
    await db.execute(sql`INSERT INTO model_tags (model_id, tag_id) VALUES (${DRAGON}, ${TAG})`)
    await db.execute(sql`
      INSERT INTO model_files (model_id, filename, extension, category, previewable)
      VALUES (${DRAGON}, 'presupported/dragon_body.stl', 'stl', 'model', true)
    `)

    await refreshModelSearchVectors(db, [DRAGON, BOX])
  })

  afterAll(async () => {
    await cleanup()
    await pool.end()
  })

  it('populates a vector for every requested model', async () => {
    const res = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM models
      WHERE library_id = ${LIB} AND search_vector IS NOT NULL
    `)
    expect(res.rows[0]?.n).toBe(2)
  })

  it('matches on the model name', async () => {
    expect(await search('dragon')).toEqual(['Red Dragon Miniature'])
  })

  it('matches on creator name (weight B)', async () => {
    expect(await search('loot studios')).toEqual(['Red Dragon Miniature'])
  })

  it('matches on notes (weight C)', async () => {
    expect(await search('tabletop')).toEqual(['Red Dragon Miniature'])
  })

  // Regression: the default parser treats "presupported/dragon_body.stl" as a
  // single `file` token, so this only works because refresh.ts splits on
  // non-alphanumerics before tokenising.
  it('matches a word inside a filename path (weight D)', async () => {
    expect(await search('presupported')).toEqual(['Red Dragon Miniature'])
    expect(await search('stl')).toEqual(['Red Dragon Miniature'])
  })

  it('folds accents, so "pokemon" finds the tag "Pokémon"', async () => {
    expect(await search('pokemon')).toEqual(['Red Dragon Miniature'])
  })

  it('stems, so "game" finds "games"', async () => {
    expect(await search('game')).toEqual(['Red Dragon Miniature'])
  })

  it('supports websearch negation', async () => {
    expect(await search('print -dragon')).toEqual(['Hinged Storage Box'])
  })

  it('tolerates dropped and doubled letters via trigram', async () => {
    expect(await fuzzy('draggon')).toContain('Red Dragon Miniature')
    expect(await fuzzy('dragn')).toContain('Red Dragon Miniature')
    expect(await fuzzy('minature')).toContain('Red Dragon Miniature')
  })

  it('does not match unrelated words', async () => {
    expect(await fuzzy('banana')).toEqual([])
    expect(await search('banana')).toEqual([])
  })

  // Documented limitation: transpositions share too few trigrams. If this ever
  // starts passing, the threshold was lowered — check for false positives.
  it('does NOT tolerate transpositions at threshold 0.5 (known limit)', async () => {
    expect(await fuzzy('dargon')).toEqual([])
  })
})
