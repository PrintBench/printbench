import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createDb, schema } from '@pb/db'
import { hashAccountPassword, verifyAccountPassword } from './auth'
import {
  issuePasswordReset,
  PasswordRecoveryError,
  resetPassword,
  validatePasswordReset,
} from './password-recovery'

const url = process.env.DATABASE_URL
const oldPassword = 'previous-password-123'
const newPassword = 'replacement-password-456'

describe('administrator-issued password recovery', { tags: ['integration'] }, () => {
  let pool: ReturnType<typeof createDb>['pool']
  let db: ReturnType<typeof createDb>['db']
  let userId: string
  let accountId: string
  let originalHash: string

  beforeAll(async () => {
    ;({ pool, db } = createDb(url))
    originalHash = await hashAccountPassword(oldPassword)
  })

  beforeEach(async () => {
    userId = randomUUID()
    accountId = randomUUID()
    await db.insert(schema.user).values({
      id: userId,
      name: 'Recovery Test',
      email: `recovery-${userId}@example.test`,
    })
    await db.insert(schema.account).values({
      id: accountId,
      userId,
      accountId: userId,
      providerId: 'credential',
      password: originalHash,
    })
    await db.insert(schema.session).values({
      id: randomUUID(),
      userId,
      token: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
  })

  afterEach(async () => {
    await db
      .delete(schema.verification)
      .where(eq(schema.verification.id, `printbench-password-reset:${userId}`))
    await db.delete(schema.user).where(eq(schema.user.id, userId))
  })

  afterAll(async () => {
    await pool.end()
  })

  it('persists only the digest of a random token and expires it after one hour', async () => {
    const now = new Date('2026-01-01T00:00:00Z')
    const { token, expiresAt } = await issuePasswordReset(db, userId, { now: () => now })
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(expiresAt.getTime() - now.getTime()).toBe(3_600_000)
    const [record] = await db
      .select()
      .from(schema.verification)
      .where(eq(schema.verification.id, `printbench-password-reset:${userId}`))
    expect(record!.identifier).toMatch(/^printbench-password-reset:[a-f0-9]{64}$/)
    expect(JSON.stringify(record)).not.toContain(token)
    await expect(validatePasswordReset(db, token, { now: () => now })).resolves.toBeUndefined()
  })

  it('updates the compatible password hash, consumes the link, and revokes every session', async () => {
    await db.insert(schema.session).values({
      id: randomUUID(),
      userId,
      token: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { token } = await issuePasswordReset(db, userId)
    await resetPassword(db, { token, password: newPassword })
    const [account] = await db.select().from(schema.account).where(eq(schema.account.id, accountId))
    expect(account!.password).not.toBe(originalHash)
    expect(account!.password).not.toContain(newPassword)
    expect(await verifyAccountPassword({ hash: account!.password!, password: newPassword })).toBe(
      true,
    )
    expect(await verifyAccountPassword({ hash: account!.password!, password: oldPassword })).toBe(
      false,
    )
    expect(await db.select().from(schema.session).where(eq(schema.session.userId, userId))).toEqual(
      [],
    )
    await expect(resetPassword(db, { token, password: oldPassword })).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    })
  })

  it('invalidates a previous link when an administrator issues another', async () => {
    const first = await issuePasswordReset(db, userId)
    const second = await issuePasswordReset(db, userId)
    expect(first.token).not.toBe(second.token)
    await expect(validatePasswordReset(db, first.token)).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    })
    await expect(validatePasswordReset(db, second.token)).resolves.toBeUndefined()
  })

  it('allows only one of two concurrent password resets to commit', async () => {
    const { token } = await issuePasswordReset(db, userId)
    const results = await Promise.allSettled([
      resetPassword(db, { token, password: newPassword }),
      resetPassword(db, { token, password: oldPassword }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected).toMatchObject({ reason: { code: 'INVALID_TOKEN' } })
  })

  it('serializes simultaneous issuance so only the latest link remains usable', async () => {
    const links = await Promise.all([
      issuePasswordReset(db, userId),
      issuePasswordReset(db, userId),
    ])
    const results = await Promise.allSettled(
      links.map(({ token }) => validatePasswordReset(db, token)),
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  })

  it('rejects a link at its exact expiry without changing password or sessions', async () => {
    const now = new Date()
    const { token, expiresAt } = await issuePasswordReset(db, userId, { now: () => now })
    await expect(
      resetPassword(db, { token, password: newPassword }, { now: () => expiresAt }),
    ).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
    const [account] = await db.select().from(schema.account).where(eq(schema.account.id, accountId))
    expect(account!.password).toBe(originalHash)
    expect(
      await db.select().from(schema.session).where(eq(schema.session.userId, userId)),
    ).toHaveLength(1)
  })

  it.each(['', 'malformed', 'a'.repeat(43), 'a'.repeat(44)])(
    'rejects an unknown token %j',
    async (token) => {
      await expect(resetPassword(db, { token, password: newPassword })).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      })
    },
  )

  it.each(['short', 'a'.repeat(201)])(
    'rejects invalid password length without consuming the link',
    async (password) => {
      const { token } = await issuePasswordReset(db, userId)
      await expect(resetPassword(db, { token, password })).rejects.toMatchObject({
        code: 'PASSWORD_LENGTH',
      })
      await expect(validatePasswordReset(db, token)).resolves.toBeUndefined()
    },
  )

  it('will not issue links for suspended or missing users', async () => {
    await db.update(schema.user).set({ banned: true }).where(eq(schema.user.id, userId))
    await expect(issuePasswordReset(db, userId)).rejects.toMatchObject({
      code: 'ACCOUNT_UNAVAILABLE',
    })
    await expect(issuePasswordReset(db, randomUUID())).rejects.toMatchObject({
      code: 'ACCOUNT_UNAVAILABLE',
    })
  })

  it('rejects a user suspended after a link was issued', async () => {
    const { token } = await issuePasswordReset(db, userId)
    await db.update(schema.user).set({ banned: true }).where(eq(schema.user.id, userId))
    await expect(resetPassword(db, { token, password: newPassword })).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    })
  })

  it('will not issue links for accounts without a credential password', async () => {
    await db.update(schema.account).set({ password: null }).where(eq(schema.account.id, accountId))
    await expect(issuePasswordReset(db, userId)).rejects.toMatchObject({
      code: 'ACCOUNT_UNAVAILABLE',
    })
  })

  it('rejects a link if the original credential account was removed', async () => {
    const { token } = await issuePasswordReset(db, userId)
    await db.delete(schema.account).where(eq(schema.account.id, accountId))
    await db.insert(schema.account).values({
      id: randomUUID(),
      userId,
      accountId: userId,
      providerId: 'credential',
      password: originalHash,
    })
    await expect(resetPassword(db, { token, password: newPassword })).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    })
  })

  it('invalidates an existing link after another password change', async () => {
    const { token } = await issuePasswordReset(db, userId)
    const changedHash = await hashAccountPassword('changed-through-account-settings')
    await db
      .update(schema.account)
      .set({ password: changedHash })
      .where(eq(schema.account.id, accountId))
    await expect(validatePasswordReset(db, token)).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
    await expect(resetPassword(db, { token, password: newPassword })).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    })
    const [account] = await db.select().from(schema.account).where(eq(schema.account.id, accountId))
    expect(account!.password).toBe(changedHash)
    expect(
      await db.select().from(schema.session).where(eq(schema.session.userId, userId)),
    ).toHaveLength(1)
    const replacement = await issuePasswordReset(db, userId)
    await expect(validatePasswordReset(db, replacement.token)).resolves.toBeUndefined()
  })

  it('exposes typed recovery errors', () => {
    const error = new PasswordRecoveryError('INVALID_TOKEN')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('PasswordRecoveryError')
    expect(error.code).toBe('INVALID_TOKEN')
  })
})
