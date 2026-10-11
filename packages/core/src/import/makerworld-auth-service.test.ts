import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { createDb, schema } from '@pb/db'
import { decryptSecret } from '../security/secret-box'
import {
  startMakerWorldSignIn,
  verifyMakerWorldSignIn,
  cancelMakerWorldSignIn,
  checkMakerWorldConnection,
  MakerWorldChallengeError,
} from './makerworld-auth-service'
import { saveMakerWorldCookie } from './import-service'
import type { BambuAuthRequest } from './makerworld-auth'

const reply = (body: unknown, status = 200) => ({ status, body: Buffer.from(JSON.stringify(body)) })

describe('personal MakerWorld sign-in lifecycle', { tags: ['integration'] }, () => {
  let db: ReturnType<typeof createDb>['db']
  let pool: ReturnType<typeof createDb>['pool']
  let member: string
  let other: string
  let viewer: string
  const identifiers = () =>
    [member, other, viewer].flatMap((id) => [
      `printbench:makerworld:challenge:${id}`,
      `printbench:makerworld:attempt:${id}`,
    ])
  beforeAll(() => {
    ;({ db, pool } = createDb())
    vi.stubEnv('BETTER_AUTH_SECRET', 'makerworld-auth-test-secret')
  })
  beforeEach(async () => {
    member = `mw-signin-member-${randomUUID()}`
    other = `mw-signin-other-${randomUUID()}`
    viewer = `mw-signin-viewer-${randomUUID()}`
    await db.insert(schema.user).values(
      [member, other, viewer].map((id) => ({
        id,
        name: 'Sign-in fixture',
        email: `${id}@example.test`,
        role: id === viewer ? 'viewer' : 'member',
      })),
    )
  })
  afterEach(async () => {
    await db
      .delete(schema.verification)
      .where(inArray(schema.verification.identifier, identifiers()))
    await db.delete(schema.user).where(inArray(schema.user.id, [member, other, viewer]))
  })
  afterAll(async () => {
    vi.unstubAllEnvs()
    await pool.end()
  })
  const start = (send: BambuAuthRequest, userId = member) =>
    startMakerWorldSignIn(db, userId, 'bambu-user@example.test', 'private-password', send)
  async function emailChallenge() {
    const send = vi.fn<BambuAuthRequest>().mockResolvedValue(reply({ loginType: 'verifyCode' }))
    const result = await start(send)
    if (result.state !== 'verification') throw new Error('Expected challenge')
    return result
  }

  it('persists encrypted short-lived verification details, never the password or code', async () => {
    const result = await emailChallenge()
    const [row] = await db
      .select()
      .from(schema.verification)
      .where(eq(schema.verification.id, result.challengeId))
    expect(row!.expiresAt.getTime() - Date.now()).toBeGreaterThan(9 * 60_000)
    expect(row!.value).not.toContain('bambu-user')
    expect(decryptSecret(row!.value)).not.toContain('private-password')
    expect(JSON.parse(decryptSecret(row!.value)!)).toMatchObject({
      purpose: 'makerworld-sign-in',
      method: 'email',
      email: 'bambu-user@example.test',
    })
    expect(JSON.stringify(result)).not.toContain('bambu-user')
    expect(JSON.parse(decryptSecret(row!.value)!).generation).toMatch(/^[0-9a-f-]{36}$/)
  })
  it('saves only an encrypted issued token for the signed-in user, and consumes verification', async () => {
    const challenge = await emailChallenge()
    const send = vi
      .fn<BambuAuthRequest>()
      .mockResolvedValueOnce(reply({ accessToken: 'own.token' }))
      .mockResolvedValueOnce(reply({}))
    expect(await verifyMakerWorldSignIn(db, member, challenge.challengeId, '123456', send)).toEqual(
      { state: 'connected' },
    )
    const [row] = await db
      .select()
      .from(schema.providerCredentials)
      .where(eq(schema.providerCredentials.userId, member))
    expect(row!.makerWorldCookieEncrypted).not.toContain('own.token')
    expect(decryptSecret(row!.makerWorldCookieEncrypted)).toBe('own.token')
    expect(
      await db
        .select()
        .from(schema.providerCredentials)
        .where(eq(schema.providerCredentials.userId, other)),
    ).toHaveLength(0)
    await expect(
      verifyMakerWorldSignIn(db, member, challenge.challengeId, '123456', send),
    ).rejects.toThrow('expired or was cancelled')
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('does not let another user claim the challenge, and rechecks permissions on verification', async () => {
    const challenge = await emailChallenge()
    const send = vi.fn<BambuAuthRequest>()
    await expect(
      verifyMakerWorldSignIn(db, other, challenge.challengeId, '123456', send),
    ).rejects.toThrow('expired or was cancelled')
    expect(
      await db
        .select()
        .from(schema.verification)
        .where(eq(schema.verification.id, challenge.challengeId)),
    ).toHaveLength(1)
    await db.update(schema.user).set({ banned: true }).where(eq(schema.user.id, member))
    await expect(
      verifyMakerWorldSignIn(db, member, challenge.challengeId, '123456', send),
    ).rejects.toThrow()
    await expect(start(send, viewer)).rejects.toThrow()
    expect(send).not.toHaveBeenCalled()
  })
  it('refuses expired, cancelled and replaced challenges before contacting Bambu', async () => {
    const expired = await emailChallenge()
    await db
      .update(schema.verification)
      .set({ expiresAt: new Date(0) })
      .where(eq(schema.verification.id, expired.challengeId))
    const send = vi.fn<BambuAuthRequest>()
    await expect(
      verifyMakerWorldSignIn(db, member, expired.challengeId, '123456', send),
    ).rejects.toThrow('expired')
    const cancelled = await emailChallenge()
    await cancelMakerWorldSignIn(db, member)
    await expect(
      verifyMakerWorldSignIn(db, member, cancelled.challengeId, '123456', send),
    ).rejects.toThrow('cancelled')
    const replaced = await emailChallenge()
    await emailChallenge()
    await expect(
      verifyMakerWorldSignIn(db, member, replaced.challengeId, '123456', send),
    ).rejects.toThrow('cancelled')
    expect(send).not.toHaveBeenCalled()
  })
  it('rotates the retry ID after a wrong code without extending the expiry or replacing the saved connection', async () => {
    await saveMakerWorldCookie(db, member, 'previous.token')
    const challenge = await emailChallenge()
    const [before] = await db
      .select()
      .from(schema.verification)
      .where(eq(schema.verification.id, challenge.challengeId))
    const send = vi.fn<BambuAuthRequest>().mockResolvedValue(reply({ error: 'private-code' }, 400))
    let retryId: string | null = null
    try {
      await verifyMakerWorldSignIn(db, member, challenge.challengeId, '123456', send)
    } catch (error) {
      expect(error).toBeInstanceOf(MakerWorldChallengeError)
      retryId = (error as MakerWorldChallengeError).retryChallengeId
      expect((error as Error).message).not.toContain('private-code')
    }
    expect(retryId).toBeTruthy()
    expect(retryId).not.toBe(challenge.challengeId)
    const [after] = await db
      .select()
      .from(schema.verification)
      .where(eq(schema.verification.id, retryId!))
    expect(after!.expiresAt).toEqual(before!.expiresAt)
    const [credentials] = await db
      .select()
      .from(schema.providerCredentials)
      .where(eq(schema.providerCredentials.userId, member))
    expect(decryptSecret(credentials!.makerWorldCookieEncrypted)).toBe('previous.token')
  })
  it('does not restore a cancelled sign-in from an in-flight verification response', async () => {
    const challenge = await emailChallenge()
    let release!: (value: ReturnType<typeof reply>) => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const send = vi.fn<BambuAuthRequest>().mockImplementation(() => {
      entered()
      return new Promise((resolve) => {
        release = resolve
      })
    })
    const completing = verifyMakerWorldSignIn(db, member, challenge.challengeId, '123456', send)
    const rejected = expect(completing).rejects.toThrow('cancelled')
    await started
    await cancelMakerWorldSignIn(db, member)
    release(reply({ accessToken: 'cancelled.token' }))
    await rejected
    expect(
      await db
        .select()
        .from(schema.providerCredentials)
        .where(eq(schema.providerCredentials.userId, member)),
    ).toHaveLength(0)
    expect(
      await db
        .select()
        .from(schema.verification)
        .where(eq(schema.verification.identifier, `printbench:makerworld:challenge:${member}`)),
    ).toHaveLength(0)
  })
  it('does not overwrite a newer sign-in with an older in-flight login', async () => {
    let release!: (value: ReturnType<typeof reply>) => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const oldSend = vi.fn<BambuAuthRequest>().mockImplementation(() => {
      entered()
      return new Promise((resolve) => {
        release = resolve
      })
    })
    const oldLogin = start(oldSend)
    const rejected = expect(oldLogin).rejects.toThrow('cancelled')
    await started
    const newSend = vi
      .fn<BambuAuthRequest>()
      .mockResolvedValueOnce(reply({ accessToken: 'new.token' }))
      .mockResolvedValueOnce(reply({}))
    expect(await start(newSend)).toEqual({ state: 'connected' })
    release(reply({ accessToken: 'old.token' }))
    await rejected
    const [credentials] = await db
      .select()
      .from(schema.providerCredentials)
      .where(eq(schema.providerCredentials.userId, member))
    expect(decryptSecret(credentials!.makerWorldCookieEncrypted)).toBe('new.token')
  })
  it('enforces an atomic attempt limit across concurrent requests', async () => {
    const send = vi.fn<BambuAuthRequest>().mockResolvedValue(reply({ error: 'invalid' }, 400))
    const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => start(send)))
    expect(send).toHaveBeenCalledTimes(8)
    expect(
      attempts.filter(
        (result) =>
          result.status === 'rejected' && (result.reason as Error).message.includes('Too many'),
      ),
    ).toHaveLength(4)
    const rows = await db
      .select()
      .from(schema.verification)
      .where(eq(schema.verification.identifier, `printbench:makerworld:attempt:${member}`))
    expect(rows).toHaveLength(8)
  })
  it('does not issue a sign-in if encrypted credential storage is unavailable', async () => {
    const send = vi.fn<BambuAuthRequest>()
    vi.stubEnv('BETTER_AUTH_SECRET', '')
    await expect(start(send)).rejects.toThrow('cannot be encrypted')
    vi.stubEnv('BETTER_AUTH_SECRET', 'makerworld-auth-test-secret')
    expect(send).not.toHaveBeenCalled()
  })
  it('handles direct success and unavailable status without claiming a confirmed connection', async () => {
    const send = vi
      .fn<BambuAuthRequest>()
      .mockResolvedValueOnce(reply({ accessToken: 'own.token' }))
      .mockResolvedValueOnce(reply({}, 503))
    expect(await start(send)).toEqual({ state: 'saved' })
    const check = vi
      .fn<BambuAuthRequest>()
      .mockResolvedValue(reply({ code: 4, error: 'Please login.' }, 401))
    expect(await checkMakerWorldConnection(db, member, check)).toBe('expired')
    check.mockResolvedValue(reply({}, 503))
    expect(await checkMakerWorldConnection(db, member, check)).toBe('unavailable')
    expect(await checkMakerWorldConnection(db, other, check)).toBe('not_connected')
    const [row] = await db
      .select()
      .from(schema.providerCredentials)
      .where(eq(schema.providerCredentials.userId, member))
    expect(decryptSecret(row!.makerWorldCookieEncrypted)).toBe('own.token')
  })
})
