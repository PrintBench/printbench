import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDb } from '@pb/db'
import {
  listSharedModels,
  modelByShareToken,
  revokeAllShares,
  shareModel,
  shareTokenCoversFile,
  unshareModel,
} from './share-service'

/**
 * Share links.
 *
 * These are the only way an anonymous request reaches anything, so the tests
 * are mostly about the boundary: a token opens exactly one model and its files,
 * and nothing else in the library.
 */
const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

const LIB = '5a000000-0000-4000-8000-000000000001'
const SHARED = '5aaa0000-0000-4000-8000-00000000000a'
const PRIVATE = '5aaa0000-0000-4000-8000-00000000000b'
const USER = 'share-test-user'

describeDb('share links', () => {
  let pool: ReturnType<typeof createDb>['pool']
  let db: ReturnType<typeof createDb>['db']
  let sharedFileId: string
  let privateFileId: string

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
    await db.execute(sql`DELETE FROM libraries WHERE id = ${LIB}`)
  }

  async function seed() {
    await db.execute(sql`
      INSERT INTO libraries (id, name, kind, backend, path)
      VALUES (${LIB}, 'Share Fixture', 'in_place', 'local', '/fixtures/share')`)

    for (const [id, suffix, name] of [
      [SHARED, 'a', 'Shared Dragon'],
      [PRIVATE, 'b', 'Private Golem'],
    ]) {
      await db.execute(sql`
        INSERT INTO models (id, library_id, path, name, slug, public_id, file_count, total_size)
        VALUES (${id}, ${LIB}, ${'sh/' + suffix}, ${name}, ${'sh-' + suffix},
                ${'mdsh0000000' + suffix}, 1, 1000)`)
    }

    const shared = await db.execute<{ id: string }>(sql`
      INSERT INTO model_files (model_id, filename, extension, category, media_type, size)
      VALUES (${SHARED}, 'dragon.stl', 'stl', 'model', 'model/stl', 1000) RETURNING id`)
    sharedFileId = shared.rows[0]!.id

    const priv = await db.execute<{ id: string }>(sql`
      INSERT INTO model_files (model_id, filename, extension, category, media_type, size)
      VALUES (${PRIVATE}, 'golem.stl', 'stl', 'model', 'model/stl', 1000) RETURNING id`)
    privateFileId = priv.rows[0]!.id
  }

  describe('sharing', () => {
    it('mints a link and resolves it back', async () => {
      const { token, created } = await shareModel(db, SHARED, USER)

      expect(created).toBe(true)
      const model = await modelByShareToken(db, token)
      expect(model?.name).toBe('Shared Dragon')
    })

    /*
     * The token must not be publicId: publicId is the internal URL segment, so
     * anyone who has ever seen the model knows it. Sharing built on it could
     * never be revoked in any meaningful sense.
     */
    it('mints a token unrelated to the public id', async () => {
      const { token } = await shareModel(db, SHARED, USER)
      expect(token).not.toBe('mdsh0000000a')
      expect(token.length).toBeGreaterThanOrEqual(20)
    })

    it('keeps the link stable when shared again', async () => {
      // Re-sharing must not break a URL already sent to somebody.
      const first = await shareModel(db, SHARED, USER)
      const second = await shareModel(db, SHARED, USER)

      expect(second.token).toBe(first.token)
      expect(second.created).toBe(false)
    })

    it('records who shared it and when', async () => {
      await shareModel(db, SHARED, USER)
      const rows = await db.execute<{ shared_by: string; shared_at: string }>(
        sql`SELECT shared_by, shared_at FROM models WHERE id = ${SHARED}`,
      )
      expect(rows.rows[0]!.shared_by).toBe(USER)
      expect(rows.rows[0]!.shared_at).toBeTruthy()
    })
  })

  describe('the boundary', () => {
    it('opens nothing without a token', async () => {
      await shareModel(db, SHARED, USER)
      expect(await modelByShareToken(db, '')).toBeNull()
    })

    it('does not resolve an unknown token', async () => {
      expect(await modelByShareToken(db, 'not-a-real-token-at-all')).toBeNull()
    })

    it('does not resolve a model that was never shared', async () => {
      const { token } = await shareModel(db, SHARED, USER)
      await unshareModel(db, SHARED)
      expect(await modelByShareToken(db, token)).toBeNull()
    })

    /*
     * Without a per-file check, a share token would be a way to fetch any file
     * id in the instance — which is the entire library.
     */
    it("covers the shared model's own files", async () => {
      const { token } = await shareModel(db, SHARED, USER)
      expect(await shareTokenCoversFile(db, token, sharedFileId)).toBe(true)
    })

    it("does not cover another model's files", async () => {
      const { token } = await shareModel(db, SHARED, USER)
      expect(await shareTokenCoversFile(db, token, privateFileId)).toBe(false)
    })

    it('covers nothing once revoked', async () => {
      const { token } = await shareModel(db, SHARED, USER)
      await unshareModel(db, SHARED)
      expect(await shareTokenCoversFile(db, token, sharedFileId)).toBe(false)
    })

    it('does not serve a model that has gone missing from disk', async () => {
      const { token } = await shareModel(db, SHARED, USER)
      await db.execute(sql`UPDATE models SET missing_at = now() WHERE id = ${SHARED}`)

      expect(await modelByShareToken(db, token)).toBeNull()
      expect(await shareTokenCoversFile(db, token, sharedFileId)).toBe(false)
    })

    it('rejects an absurd token without querying', async () => {
      expect(await modelByShareToken(db, 'x')).toBeNull()
      expect(await modelByShareToken(db, 'y'.repeat(500))).toBeNull()
    })
  })

  describe('revocation', () => {
    it('mints a different token if shared again after revoking', async () => {
      const first = await shareModel(db, SHARED, USER)
      await unshareModel(db, SHARED)
      const second = await shareModel(db, SHARED, USER)

      expect(second.token).not.toBe(first.token)
      // The old link must never come back.
      expect(await modelByShareToken(db, first.token)).toBeNull()
    })

    it('lists what is shared so it can be found and revoked', async () => {
      await shareModel(db, SHARED, USER)
      const shares = await listSharedModels(db)
      expect(shares.some((row) => row.id === SHARED)).toBe(true)
    })

    it('revokes everything at once', async () => {
      await shareModel(db, SHARED, USER)
      await shareModel(db, PRIVATE, USER)

      const count = await revokeAllShares(db)
      expect(count).toBeGreaterThanOrEqual(2)

      const remaining = await listSharedModels(db)
      expect(remaining.some((row) => row.id === SHARED)).toBe(false)
    })
  })
})
