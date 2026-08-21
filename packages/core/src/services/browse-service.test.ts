import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDb } from '@pb/db'
import {
  BrowseError,
  addModelToCollection,
  collectionBySlug,
  collectionsForModel,
  createCollection,
  creatorBySlug,
  deleteCollection,
  deleteTag,
  listCollections,
  listCreators,
  listTags,
  mergeTags,
  removeModelFromCollection,
  renameCollection,
  renameTag,
  setTagColor,
  tagBySlug,
} from './browse-service'

/**
 * Browsing by creator, tag and collection.
 *
 * The recurring theme is counts: they must exclude models missing from disk,
 * because a creator page promising forty models when eight are on an unplugged
 * drive sends you looking for something that is not there.
 */
const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

const LIB = '6b000000-0000-4000-8000-000000000001'
const CREATOR_A = '6b000000-0000-4000-8000-00000000000a'
const CREATOR_B = '6b000000-0000-4000-8000-00000000000b'
const TAG_X = '6b000000-0000-4000-8000-0000000000c1'
const TAG_Y = '6b000000-0000-4000-8000-0000000000c2'
const id = (suffix: string) => `6baa0000-0000-4000-8000-0000000000${suffix}`

describeDb('browse', () => {
  let pool: ReturnType<typeof createDb>['pool']
  let db: ReturnType<typeof createDb>['db']

  beforeAll(() => {
    ;({ pool, db } = createDb())
  })

  afterAll(async () => {
    await cleanup()
    await pool.end()
  })

  beforeEach(async () => {
    await cleanup()
    await seed()
  })

  async function cleanup() {
    await db.execute(sql`DELETE FROM collections WHERE name LIKE 'BrowseFixture%'`)
    await db.execute(sql`DELETE FROM libraries WHERE id = ${LIB}`)
    await db.execute(sql`
      DELETE FROM creators WHERE id IN (${CREATOR_A}, ${CREATOR_B})
         OR lower(name) IN ('browse studios', 'quiet studios', 'renamed studios')`)
    await db.execute(sql`
      DELETE FROM tags WHERE id IN (${TAG_X}, ${TAG_Y})
         OR lower(name) IN ('browsedragon', 'browseterrain', 'browsemerged')`)
  }

  async function seed() {
    await db.execute(sql`
      INSERT INTO libraries (id, name, kind, backend, path)
      VALUES (${LIB}, 'Browse Fixture', 'in_place', 'local', '/fixtures/browse')`)
    await db.execute(sql`
      INSERT INTO creators (id, name, slug, public_id) VALUES
        (${CREATOR_A}, 'Browse Studios', 'browse-studios-bx', 'crbx00000001'),
        (${CREATOR_B}, 'Quiet Studios', 'quiet-studios-bx', 'crbx00000002')`)
    await db.execute(sql`
      INSERT INTO tags (id, name, slug) VALUES
        (${TAG_X}, 'BrowseDragon', 'browsedragon-bx'),
        (${TAG_Y}, 'BrowseTerrain', 'browseterrain-bx')`)

    // suffix, creator, missing
    const models: [string, string | null, boolean][] = [
      ['01', CREATOR_A, false],
      ['02', CREATOR_A, false],
      // On an unplugged drive: counted nowhere.
      ['03', CREATOR_A, true],
      ['04', null, false],
    ]

    for (const [suffix, creator, missing] of models) {
      await db.execute(sql`
        INSERT INTO models (id, library_id, path, name, slug, public_id, creator_id,
                            file_count, total_size, missing_at)
        VALUES (${id(suffix)}, ${LIB}, ${'bx/' + suffix}, ${'Browse Model ' + suffix},
                ${'bx-' + suffix}, ${'mdbx0000000' + suffix}, ${creator}, 1, 1000,
                ${missing ? sql`now()` : null})`)
    }

    await db.execute(sql`
      INSERT INTO model_tags (model_id, tag_id) VALUES
        (${id('01')}, ${TAG_X}),
        (${id('02')}, ${TAG_X}),
        (${id('03')}, ${TAG_X}),
        (${id('02')}, ${TAG_Y})`)
  }

  describe('creators', () => {
    it('counts only models that are present', async () => {
      const creators = await listCreators(db)
      const browse = creators.find((c) => c.id === CREATOR_A)
      // Three models, one of them missing from disk.
      expect(browse?.modelCount).toBe(2)
    })

    it('includes a creator with nothing attributed to them', async () => {
      const creators = await listCreators(db)
      expect(creators.find((c) => c.id === CREATOR_B)?.modelCount).toBe(0)
    })

    it('puts the busiest first', async () => {
      const creators = await listCreators(db)
      const a = creators.findIndex((c) => c.id === CREATOR_A)
      const b = creators.findIndex((c) => c.id === CREATOR_B)
      expect(a).toBeLessThan(b)
    })

    it('finds one by slug', async () => {
      const creator = await creatorBySlug(db, 'browse-studios-bx')
      expect(creator?.name).toBe('Browse Studios')
      expect(creator?.modelCount).toBe(2)
    })

    it('returns null for an unknown slug', async () => {
      expect(await creatorBySlug(db, 'no-such-creator')).toBeNull()
    })
  })

  describe('tags', () => {
    it('counts only models that are present', async () => {
      const tags = await listTags(db)
      expect(tags.find((t) => t.id === TAG_X)?.modelCount).toBe(2)
    })

    it('finds one by slug', async () => {
      expect((await tagBySlug(db, 'browseterrain-bx'))?.name).toBe('BrowseTerrain')
    })

    it('renames, and re-slugs to match', async () => {
      await renameTag(db, TAG_X, 'BrowseMerged')
      const tag = await tagBySlug(db, 'browsemerged')
      expect(tag?.name).toBe('BrowseMerged')
    })

    it('refuses an empty name', async () => {
      await expect(renameTag(db, TAG_X, '   ')).rejects.toThrow(BrowseError)
    })

    /*
     * Renaming onto an existing name is a merge rather than an error. The
     * alternative is a unique-index failure the user cannot act on, or two
     * tags that look identical — which is exactly how "dragon" and "Dragon"
     * both end up in a library.
     */
    it('treats a rename onto an existing name as a merge', async () => {
      await renameTag(db, TAG_Y, 'browsedragon')

      const tags = await listTags(db)
      expect(tags.find((t) => t.id === TAG_Y)).toBeUndefined()
      // Model 02 had both tags; it must not now be counted twice.
      expect(tags.find((t) => t.id === TAG_X)?.modelCount).toBe(2)
    })

    it('merges, keeping models tagged with both exactly once', async () => {
      await mergeTags(db, TAG_Y, TAG_X)

      const rows = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM model_tags
        WHERE tag_id = ${TAG_X} AND model_id = ${id('02')}`)
      expect(rows.rows[0]!.n).toBe(1)
    })

    it('refuses to merge a tag into itself', async () => {
      await expect(mergeTags(db, TAG_X, TAG_X)).rejects.toThrow(BrowseError)
    })

    it('sets a colour', async () => {
      await setTagColor(db, TAG_X, '#1a2b3c')
      expect((await tagBySlug(db, 'browsedragon-bx'))?.color).toBe('#1a2b3c')
    })

    it('refuses a colour that is not hex', async () => {
      await expect(setTagColor(db, TAG_X, 'red')).rejects.toThrow(BrowseError)
    })

    it('clears a colour', async () => {
      await setTagColor(db, TAG_X, '#1a2b3c')
      await setTagColor(db, TAG_X, null)
      expect((await tagBySlug(db, 'browsedragon-bx'))?.color).toBeNull()
    })

    /*
     * Names are unique case-insensitively but slugs are not injective:
     * "BrowseDragon!" and "BrowseDragon?" both reduce to "browsedragon". The
     * second rename would otherwise fail on the unique slug index.
     */
    it('survives two names that reduce to the same slug', async () => {
      await renameTag(db, TAG_X, 'BrowseDragon!')
      await renameTag(db, TAG_Y, 'BrowseDragon?')

      const tags = await listTags(db)
      const first = tags.find((t) => t.id === TAG_X)
      const second = tags.find((t) => t.id === TAG_Y)

      expect(first?.name).toBe('BrowseDragon!')
      expect(second?.name).toBe('BrowseDragon?')
      // Both still exist, and their slugs differ.
      expect(first!.slug).not.toBe(second!.slug)
    })

    it('deletes a tag without touching the models', async () => {
      const affected = await deleteTag(db, TAG_X)
      expect(affected).toBe(3)

      const models = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM models WHERE library_id = ${LIB}`,
      )
      expect(models.rows[0]!.n).toBe(4)
      expect(await tagBySlug(db, 'browsedragon-bx')).toBeNull()
    })
  })

  describe('collections', () => {
    it('creates one and finds it back', async () => {
      const { slug } = await createCollection(db, {
        name: 'BrowseFixture Terrain',
        caption: 'Bits of scenery',
      })
      const collection = await collectionBySlug(db, slug)

      expect(collection?.name).toBe('BrowseFixture Terrain')
      expect(collection?.caption).toBe('Bits of scenery')
    })

    // Two people naming a collection "Terrain" is normal, and slugs are unique.
    it('gives two collections of the same name different slugs', async () => {
      const first = await createCollection(db, { name: 'BrowseFixture Same' })
      const second = await createCollection(db, { name: 'BrowseFixture Same' })
      expect(first.slug).not.toBe(second.slug)
    })

    it('refuses an empty name', async () => {
      await expect(createCollection(db, { name: '  ' })).rejects.toThrow(BrowseError)
    })

    it('adds and removes models', async () => {
      const { id: collectionId, slug } = await createCollection(db, { name: 'BrowseFixture Pack' })

      await addModelToCollection(db, collectionId, id('01'))
      await addModelToCollection(db, collectionId, id('02'))
      expect((await collectionBySlug(db, slug))?.modelCount).toBe(2)

      await removeModelFromCollection(db, collectionId, id('01'))
      expect((await collectionBySlug(db, slug))?.modelCount).toBe(1)
    })

    it('does not add the same model twice', async () => {
      const { id: collectionId, slug } = await createCollection(db, { name: 'BrowseFixture Dup' })
      await addModelToCollection(db, collectionId, id('01'))
      await addModelToCollection(db, collectionId, id('01'))
      expect((await collectionBySlug(db, slug))?.modelCount).toBe(1)
    })

    it('does not count a model missing from disk', async () => {
      const { id: collectionId, slug } = await createCollection(db, { name: 'BrowseFixture Gone' })
      await addModelToCollection(db, collectionId, id('03'))
      expect((await collectionBySlug(db, slug))?.modelCount).toBe(0)
    })

    it('reports which collections a model is in', async () => {
      const { id: collectionId } = await createCollection(db, { name: 'BrowseFixture Member' })
      await addModelToCollection(db, collectionId, id('01'))

      const memberships = await collectionsForModel(db, id('01'))
      expect(memberships.map((c) => c.name)).toContain('BrowseFixture Member')
    })

    it('renames', async () => {
      const { id: collectionId, slug } = await createCollection(db, { name: 'BrowseFixture Old' })
      await renameCollection(db, collectionId, 'BrowseFixture New')
      expect((await collectionBySlug(db, slug))?.name).toBe('BrowseFixture New')
    })

    /*
     * Deleting a folder must never take its contents with it. Children move up
     * to the deleted collection's own parent, and the models are untouched.
     */
    it('re-parents children rather than deleting them', async () => {
      const parent = await createCollection(db, { name: 'BrowseFixture Parent' })
      const middle = await createCollection(db, {
        name: 'BrowseFixture Middle',
        parentId: parent.id,
      })
      const child = await createCollection(db, {
        name: 'BrowseFixture Child',
        parentId: middle.id,
      })

      await deleteCollection(db, middle.id)

      const remaining = await collectionBySlug(db, child.slug)
      expect(remaining).toBeTruthy()
      expect(remaining?.parentId).toBe(parent.id)
    })

    it('leaves models alone when a collection goes', async () => {
      const { id: collectionId } = await createCollection(db, { name: 'BrowseFixture Doomed' })
      await addModelToCollection(db, collectionId, id('01'))
      await deleteCollection(db, collectionId)

      const models = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM models WHERE id = ${id('01')}`,
      )
      expect(models.rows[0]!.n).toBe(1)
    })

    it('lists them', async () => {
      await createCollection(db, { name: 'BrowseFixture Listed' })
      const all = await listCollections(db)
      expect(all.some((c) => c.name === 'BrowseFixture Listed')).toBe(true)
    })
  })
})
