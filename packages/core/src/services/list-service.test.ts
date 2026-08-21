import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDb } from '@pb/db'
import {
  ListError,
  createList,
  deleteList,
  ensureLikedList,
  isLiked,
  likedAmong,
  likedCount,
  listLiked,
  listsFor,
  toggleLike,
} from './list-service'

/**
 * Liked models and lists.
 *
 * The liked list is created on first use rather than at sign-up, so most of
 * these are about that happening exactly once — including when two tabs like
 * something at the same moment.
 */
const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

const LIB = '7c000000-0000-4000-8000-000000000001'
const USER = 'list-test-user'
const OTHER_USER = 'list-test-other'
const id = (suffix: string) => `7caa0000-0000-4000-8000-0000000000${suffix}`

describeDb('lists and likes', () => {
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
    await db.execute(sql`DELETE FROM lists WHERE user_id IN (${USER}, ${OTHER_USER})`)
    await db.execute(sql`DELETE FROM libraries WHERE id = ${LIB}`)
    await db.execute(sql`DELETE FROM "user" WHERE id IN (${USER}, ${OTHER_USER})`)
  }

  async function seed() {
    // lists.user_id has a foreign key, so the accounts have to exist.
    for (const user of [USER, OTHER_USER]) {
      await db.execute(sql`
        INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
        VALUES (${user}, ${user}, ${`${user}@example.test`}, false, now(), now())`)
    }

    await db.execute(sql`
      INSERT INTO libraries (id, name, kind, backend, path)
      VALUES (${LIB}, 'Liked Fixture', 'in_place', 'local', '/fixtures/liked')`)

    for (const [suffix, missing] of [
      ['01', false],
      ['02', false],
      ['03', true],
    ] as [string, boolean][]) {
      await db.execute(sql`
        INSERT INTO models (id, library_id, path, name, slug, public_id, file_count, total_size,
                            missing_at)
        VALUES (${id(suffix)}, ${LIB}, ${'lk/' + suffix}, ${'Liked Model ' + suffix},
                ${'lk-' + suffix}, ${'mdlk0000000' + suffix}, 1, 1000,
                ${missing ? sql`now()` : null})`)
    }
  }

  describe('the liked list', () => {
    it('is created on first use, not at sign-up', async () => {
      const before = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM lists WHERE user_id = ${USER}`,
      )
      expect(before.rows[0]!.n).toBe(0)

      await ensureLikedList(db, USER)

      const after = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM lists WHERE user_id = ${USER} AND kind = 'liked'`,
      )
      expect(after.rows[0]!.n).toBe(1)
    })

    it('returns the same list every time', async () => {
      const first = await ensureLikedList(db, USER)
      const second = await ensureLikedList(db, USER)
      expect(second).toBe(first)
    })

    /*
     * Two tabs liking something at the same moment. The partial unique index
     * resolves it at the database; the loser has to notice and use the winner's
     * list rather than throwing.
     */
    it('survives two callers racing', async () => {
      const [a, b, c] = await Promise.all([
        ensureLikedList(db, USER),
        ensureLikedList(db, USER),
        ensureLikedList(db, USER),
      ])
      expect(b).toBe(a)
      expect(c).toBe(a)

      const rows = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM lists WHERE user_id = ${USER} AND kind = 'liked'`,
      )
      expect(rows.rows[0]!.n).toBe(1)
    })

    it('gives each user their own', async () => {
      const mine = await ensureLikedList(db, USER)
      const theirs = await ensureLikedList(db, OTHER_USER)
      expect(theirs).not.toBe(mine)
    })
  })

  describe('liking', () => {
    it('toggles on and off', async () => {
      expect(await toggleLike(db, USER, id('01'))).toEqual({ liked: true })
      expect(await isLiked(db, USER, id('01'))).toBe(true)

      expect(await toggleLike(db, USER, id('01'))).toEqual({ liked: false })
      expect(await isLiked(db, USER, id('01'))).toBe(false)
    })

    it('is per user', async () => {
      await toggleLike(db, USER, id('01'))
      expect(await isLiked(db, OTHER_USER, id('01'))).toBe(false)
    })

    it('reports nothing liked for a user who never has', async () => {
      expect(await isLiked(db, USER, id('01'))).toBe(false)
      expect(await likedCount(db, USER)).toBe(0)
    })

    /*
     * Asked once for a whole grid: a query per card turns forty-eight cards
     * into forty-eight round trips.
     */
    it('answers for a page of models at once', async () => {
      await toggleLike(db, USER, id('01'))

      const liked = await likedAmong(db, USER, [id('01'), id('02')])
      expect(liked.has(id('01'))).toBe(true)
      expect(liked.has(id('02'))).toBe(false)
    })

    it('handles being asked about nothing', async () => {
      expect((await likedAmong(db, USER, [])).size).toBe(0)
    })

    it('lists what is liked, newest first', async () => {
      await toggleLike(db, USER, id('01'))
      await toggleLike(db, USER, id('02'))

      const liked = await listLiked(db, USER)
      expect(liked).toHaveLength(2)
      expect(liked[0]!.name).toBe('Liked Model 02')
      expect(liked[0]!.libraryName).toBe('Liked Fixture')
    })

    // A liked model on an unplugged drive is not something to show in a grid.
    it('hides a model missing from disk', async () => {
      await toggleLike(db, USER, id('03'))

      expect(await listLiked(db, USER)).toHaveLength(0)
      expect(await likedCount(db, USER)).toBe(0)
      // Still liked, though: the row survives so it returns when the drive does.
      expect(await isLiked(db, USER, id('03'))).toBe(true)
    })

    it('paginates', async () => {
      await toggleLike(db, USER, id('01'))
      await toggleLike(db, USER, id('02'))

      expect(await listLiked(db, USER, { limit: 1 })).toHaveLength(1)
      expect(await listLiked(db, USER, { limit: 1, offset: 1 })).toHaveLength(1)
    })
  })

  describe('named lists', () => {
    it('creates one', async () => {
      const { id: listId } = await createList(db, USER, 'To Print')
      const lists = await listsFor(db, USER)
      expect(lists.find((l) => l.id === listId)?.name).toBe('To Print')
    })

    it('refuses an empty name', async () => {
      await expect(createList(db, USER, '   ')).rejects.toThrow(ListError)
    })

    it('puts liked first', async () => {
      await createList(db, USER, 'Aardvark')
      await ensureLikedList(db, USER)

      const lists = await listsFor(db, USER)
      expect(lists[0]!.kind).toBe('liked')
    })

    it('shows only your own lists', async () => {
      await createList(db, OTHER_USER, 'Theirs')
      expect((await listsFor(db, USER)).some((l) => l.name === 'Theirs')).toBe(false)
    })

    it('deletes one', async () => {
      const { id: listId } = await createList(db, USER, 'Temporary')
      await deleteList(db, USER, listId)
      expect((await listsFor(db, USER)).some((l) => l.id === listId)).toBe(false)
    })

    it('refuses to delete someone else\'s list', async () => {
      const { id: listId } = await createList(db, OTHER_USER, 'Theirs')
      await expect(deleteList(db, USER, listId)).rejects.toThrow(ListError)
    })

    /*
     * The liked list comes back on the next like anyway, so removing it only
     * discards the likes.
     */
    it('refuses to delete the liked list', async () => {
      const likedId = await ensureLikedList(db, USER)
      await expect(deleteList(db, USER, likedId)).rejects.toThrow(ListError)
    })
  })
})
