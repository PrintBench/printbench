import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDb } from '@pb/db'
import {
  InviteError,
  consumeInvite,
  createInvite,
  inviteByToken,
  listPendingInvites,
  revokeInvite,
} from './invite-service'

/**
 * Invitations.
 *
 * The token is the entire authorisation — there is no session behind it and
 * no email to prove ownership — so most of what matters here is what a token
 * stops working after: being used, being revoked, and running out of time.
 */
const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

const ADMIN = 'invite-test-admin'
const JOINER = 'invite-test-joiner'

describeDb('invitations', () => {
  let pool: ReturnType<typeof createDb>['pool']
  let db: ReturnType<typeof createDb>['db']

  beforeAll(async () => {
    ;({ pool, db } = createDb())
  })

  afterAll(async () => {
    await cleanup()
    await pool.end()
  })

  beforeEach(async () => {
    await cleanup()
    await db.execute(sql`
      INSERT INTO "user" (id, name, email, email_verified, role) VALUES
        (${ADMIN}, 'Invite Admin', 'invite-admin@example.test', true, 'admin'),
        (${JOINER}, 'Invite Joiner', 'invite-joiner@example.test', true, 'viewer')`)
  })

  async function cleanup() {
    await db.execute(sql`DELETE FROM invitations WHERE created_by IN (${ADMIN}, ${JOINER})`)
    await db.execute(sql`DELETE FROM "user" WHERE id IN (${ADMIN}, ${JOINER})`)
    await db.execute(sql`DELETE FROM "user" WHERE email = 'someone@example.test'`)
  }

  const mint = (email?: string | null) =>
    createInvite(db, { email, role: 'member', createdBy: ADMIN })

  describe('minting', () => {
    it('produces a token that resolves', async () => {
      const { token } = await mint()
      const invitation = await inviteByToken(db, token)
      expect(invitation?.role).toBe('member')
    })

    it('carries the address when one was given', async () => {
      const { token } = await mint('someone@example.test')
      expect((await inviteByToken(db, token))?.email).toBe('someone@example.test')
    })

    it('normalises the address', async () => {
      const { token } = await mint('  SomeOne@Example.test ')
      expect((await inviteByToken(db, token))?.email).toBe('someone@example.test')
    })

    it('refuses an address that already has an account', async () => {
      await expect(mint('invite-joiner@example.test')).rejects.toThrow(InviteError)
    })

    it('refuses something that is not an address', async () => {
      await expect(mint('not-an-email')).rejects.toThrow(InviteError)
    })

    it('refuses a role that does not exist', async () => {
      await expect(
        createInvite(db, { role: 'superuser' as 'admin', createdBy: ADMIN }),
      ).rejects.toThrow(InviteError)
    })

    /*
     * Two links minted in a row must not collide, or the second would fail on
     * the unique index — or worse, resolve to the first.
     */
    it('mints a different token each time', async () => {
      const [a, b] = [await mint(), await mint()]
      expect(a.token).not.toBe(b.token)
    })
  })

  describe('what stops a token working', () => {
    it('being used', async () => {
      const { token } = await mint()
      const invitation = await inviteByToken(db, token)

      expect(await consumeInvite(db, invitation!.id, JOINER)).toBe(true)
      expect(await inviteByToken(db, token)).toBeNull()
    })

    /*
     * The race that matters: two people opening the same link at once. The
     * conditional UPDATE means exactly one wins, and the loser is told so
     * rather than quietly getting an account with the role attached.
     */
    it('being used by someone else first', async () => {
      const { token } = await mint()
      const invitation = await inviteByToken(db, token)

      const [first, second] = await Promise.all([
        consumeInvite(db, invitation!.id, JOINER),
        consumeInvite(db, invitation!.id, ADMIN),
      ])

      expect([first, second].filter(Boolean)).toHaveLength(1)
    })

    it('being revoked', async () => {
      const { token } = await mint()
      const invitation = await inviteByToken(db, token)

      expect(await revokeInvite(db, invitation!.id)).toBe(true)
      expect(await inviteByToken(db, token)).toBeNull()
      // And a revoked link cannot then be redeemed by a racing request.
      expect(await consumeInvite(db, invitation!.id, JOINER)).toBe(false)
    })

    it('expiring', async () => {
      const { token } = await mint()
      await db.execute(sql`
        UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE token = ${token}`)

      expect(await inviteByToken(db, token)).toBeNull()
    })

    it('never having existed', async () => {
      expect(await inviteByToken(db, 'not-a-real-token')).toBeNull()
    })

    it('being absurd', async () => {
      // Guarded before it reaches the database.
      expect(await inviteByToken(db, 'x'.repeat(500))).toBeNull()
      expect(await inviteByToken(db, '')).toBeNull()
    })
  })

  describe('the pending list', () => {
    it('shows a fresh invitation, with who sent it', async () => {
      await mint('someone@example.test')
      const pending = await listPendingInvites(db)
      const entry = pending.find((row) => row.email === 'someone@example.test')

      expect(entry).toBeDefined()
      expect(entry?.invitedByName).toBe('Invite Admin')
    })

    it('drops one that was used, revoked or expired', async () => {
      const used = await mint()
      const revoked = await mint()
      const expired = await mint()

      await consumeInvite(db, (await inviteByToken(db, used.token))!.id, JOINER)
      await revokeInvite(db, (await inviteByToken(db, revoked.token))!.id)
      await db.execute(sql`
        UPDATE invitations SET expires_at = now() - interval '1 day' WHERE token = ${expired.token}`)

      const tokens = (await listPendingInvites(db)).map((row) => row.token)
      expect(tokens).not.toContain(used.token)
      expect(tokens).not.toContain(revoked.token)
      expect(tokens).not.toContain(expired.token)
    })
  })
})
