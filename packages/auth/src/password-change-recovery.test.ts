import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { createDb, schema } from '@pb/db'
import { createAuth, verifyAccountPassword } from './auth'
import { issuePasswordReset, resetPassword, validatePasswordReset } from './password-recovery'

const describeDb = process.env.DATABASE_URL ? describe : describe.skip
const originalPassword = 'original-password-123'
const recoveryPassword = 'recovered-password-456'
const changedPassword = 'stale-change-password-789'
const origin = 'http://localhost:3000'

function latch() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describeDb('native password changes serialize with recovery', () => {
  let db: ReturnType<typeof createDb>['db']
  let pool: ReturnType<typeof createDb>['pool']
  let auth: ReturnType<typeof createAuth>
  let userId: string
  let headers: Headers

  beforeAll(() => {
    vi.stubEnv('BETTER_AUTH_URL', origin)
    vi.stubEnv('BETTER_AUTH_SECRET', 'isolated-recovery-race-secret-at-least-32-characters')
    ;({ db, pool } = createDb())
  })

  beforeEach(async () => {
    auth = createAuth(db)
    const signedUp = await auth.api.signUpEmail({
      body: {
        name: 'Password Race Test',
        email: `recovery-race-${randomUUID()}@example.test`,
        password: originalPassword,
      },
      returnHeaders: true,
    })
    userId = signedUp.response.user.id
    headers = new Headers({
      origin,
      cookie: signedUp.headers
        .getSetCookie()
        .map((cookie) => cookie.split(';')[0])
        .join('; '),
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await db
      .delete(schema.verification)
      .where(eq(schema.verification.id, `printbench-password-reset:${userId}`))
    await db.delete(schema.user).where(eq(schema.user.id, userId))
  })

  afterAll(async () => {
    await pool.end()
    vi.unstubAllEnvs()
  })

  function changePassword(entry: 'handler' | 'api' | 'request-api') {
    const body = {
      currentPassword: originalPassword,
      newPassword: changedPassword,
      revokeOtherSessions: true,
    }
    const request = new Request(`${origin}/api/auth/change-password`, {
      method: 'POST',
      headers: new Headers({ ...Object.fromEntries(headers), 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    })
    if (entry === 'handler') return auth.handler(request)
    // Better Auth's sensitive-session middleware in 1.7.5 requires explicit
    // headers even when the direct API call also carries a Request.
    if (entry === 'request-api') {
      return auth.api.changePassword({ request, headers: request.headers, body, asResponse: true })
    }
    return auth.api.changePassword({ headers, body })
  }

  async function assertPassword(password: string) {
    const [account] = await db
      .select()
      .from(schema.account)
      .where(eq(schema.account.userId, userId))
    expect(await verifyAccountPassword({ hash: account!.password!, password })).toBe(true)
  }

  it.each(['handler', 'api', 'request-api'] as const)(
    'rejects a stale %s call after recovery wins the lock',
    async (entry) => {
      const reset = await issuePasswordReset(db, userId)
      const preflightComplete = latch()
      const continueChange = latch()
      const nativeGetSession = auth.api.getSession
      vi.spyOn(auth.api, 'getSession').mockImplementationOnce(async (input) => {
        const session = await nativeGetSession(input)
        preflightComplete.release()
        await continueChange.promise
        return session
      })
      // Capture the rejection immediately to avoid unhandled promise rejection.
      const changing = Promise.resolve(changePassword(entry)).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      )
      await preflightComplete.promise
      try {
        await resetPassword(db, { token: reset.token, password: recoveryPassword })
      } finally {
        continueChange.release()
      }
      const result = await changing
      if ('result' in result) {
        expect(result.result).toBeInstanceOf(Response)
        expect((result.result as Response).status).toBe(401)
      } else {
        expect(result.error).toMatchObject({ status: 'UNAUTHORIZED' })
      }
      await assertPassword(recoveryPassword)
      expect(
        await db.select().from(schema.session).where(eq(schema.session.userId, userId)),
      ).toEqual([])
    },
  )

  it.each(['handler', 'api', 'request-api'] as const)(
    'keeps the %s verification and replacement session under the lock',
    async (entry) => {
      const reset = await issuePasswordReset(db, userId)
      const verified = latch()
      const continueChange = latch()
      const context = await auth.$context
      const nativeVerify = context.password.verify
      vi.spyOn(context.password, 'verify').mockImplementationOnce(async (input) => {
        const valid = await nativeVerify(input)
        verified.release()
        await continueChange.promise
        return valid
      })
      const changing = Promise.resolve(changePassword(entry))
      await verified.promise
      const resetting = resetPassword(db, { token: reset.token, password: recoveryPassword }).then(
        () => ({ ok: true }),
        (error: unknown) => ({ error }),
      )
      try {
        // Observe the actual blocked PostgreSQL transaction, rather than relying
        // on a scheduling delay to infer that recovery cannot pass verification.
        await vi.waitFor(
          async () => {
            const blocked = await db.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%"user"%' AND query LIKE '%for update%'
        `)
            expect(blocked.rows[0]!.n).toBeGreaterThan(0)
          },
          { timeout: 5000, interval: 20 },
        )
      } finally {
        continueChange.release()
      }
      const changed = await changing
      if (changed instanceof Response) expect(changed.status).toBe(200)
      expect(await resetting).toMatchObject({ error: { code: 'INVALID_TOKEN' } })
      await assertPassword(changedPassword)
      const sessions = await db
        .select()
        .from(schema.session)
        .where(eq(schema.session.userId, userId))
      expect(sessions).toHaveLength(1)
      // A fresh link for this newer password version can still recover normally.
      const freshReset = await issuePasswordReset(db, userId)
      await resetPassword(db, { token: freshReset.token, password: recoveryPassword })
      await assertPassword(recoveryPassword)
      expect(
        await db.select().from(schema.session).where(eq(schema.session.userId, userId)),
      ).toEqual([])
    },
  )

  it('rolls back password/session writes when the HTTP endpoint fails after its password update', async () => {
    const reset = await issuePasswordReset(db, userId)
    const context = await auth.$context
    vi.spyOn(context.internalAdapter, 'createSession').mockRejectedValueOnce(
      new Error('Synthetic session creation failure'),
    )
    const result = await changePassword('handler')
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(500)
    await assertPassword(originalPassword)
    expect(
      await db.select().from(schema.session).where(eq(schema.session.userId, userId)),
    ).toHaveLength(1)
    await expect(validatePasswordReset(db, reset.token)).resolves.toBeUndefined()
  })

  it('retains the native origin check for directly callable HTTP requests', async () => {
    // Better Auth disables origin checking by default under NODE_ENV=test.
    // Exercise the production middleware without changing the app's settings.
    const context = await auth.$context
    context.skipOriginCheck = false
    headers.set('origin', 'https://untrusted.example')
    const result = await changePassword('handler')
    expect((result as Response).status).toBe(403)
    await assertPassword(originalPassword)
    expect(
      await db.select().from(schema.session).where(eq(schema.session.userId, userId)),
    ).toHaveLength(1)
  })

  it('does not route encoded, differently cased, or extra-slash paths to an unguarded password change', async () => {
    for (const path of [
      'change%2Dpassword',
      '%63hange-password',
      'CHANGE-PASSWORD',
      'change-password/',
      'change-password//',
      'change-password%2F',
    ]) {
      const response = await auth.handler(
        new Request(`${origin}/api/auth/${path}`, {
          method: 'POST',
          headers: new Headers({
            ...Object.fromEntries(headers),
            'content-type': 'application/json',
          }),
          body: JSON.stringify({
            currentPassword: originalPassword,
            newPassword: changedPassword,
            revokeOtherSessions: true,
          }),
        }),
      )
      expect(response.status, path).toBe(404)
    }
    await assertPassword(originalPassword)
    expect(
      await db.select().from(schema.session).where(eq(schema.session.userId, userId)),
    ).toHaveLength(1)
  })
})
