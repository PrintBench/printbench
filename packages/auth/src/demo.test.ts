// @covers DEMO-001
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDb } from '@pb/db'
import { hashAccountPassword } from './password-hash'

describe('demo auth guard', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('blocks account changes, sign-up and the admin plugin only on a demo', async () => {
    const { demoBlocksAuthPath } = await import('./auth')
    const blocked = [
      '/sign-up/email',
      '/change-password',
      '/update-user',
      '/admin/impersonate-user',
    ]
    for (const path of blocked) expect(demoBlocksAuthPath(path)).toBe(false)

    vi.stubEnv('PRINTBENCH_DEMO', '1')
    for (const path of blocked) expect(demoBlocksAuthPath(path)).toBe(true)
    // Signing in and out is the demo.
    expect(demoBlocksAuthPath('/sign-in/email')).toBe(false)
    expect(demoBlocksAuthPath('/sign-out')).toBe(false)
    expect(demoBlocksAuthPath('/get-session')).toBe(false)
  })
})

/**
 * The demo reset writes the shared account's rows itself, inside the
 * transaction that rebuilds the schema, rather than calling sign-up. This
 * proves better-auth accepts that hand-written credential, and that the demo
 * hook really refuses at the endpoint and not just in the helper above.
 */
describe('demo account against better-auth', { tags: ['integration'] }, () => {
  const EMAIL = 'demo-probe@example.test'
  const PASSWORD = 'printbench-demo-probe'
  let pool: ReturnType<typeof createDb>['pool']
  let db: ReturnType<typeof createDb>['db']
  let getAuth: typeof import('./auth').getAuth

  async function clean() {
    await db.execute(sql`DELETE FROM "user" WHERE email IN (${EMAIL}, 'demo-signup@example.test')`)
  }

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET ??= 'test-secret-at-least-32-chars-long-xx'
    process.env.BETTER_AUTH_URL ??= 'http://localhost:3000'
    ;({ pool, db } = createDb())
    await clean()
    const userId = randomUUID()
    await db.execute(sql`
      INSERT INTO "user" (id, name, email, email_verified, role)
      VALUES (${userId}, 'Demo Probe', ${EMAIL}, true, 'admin')`)
    await db.execute(sql`
      INSERT INTO account (id, account_id, provider_id, user_id, password)
      VALUES (${randomUUID()}, ${userId}, 'credential', ${userId}, ${await hashAccountPassword(PASSWORD)})`)
    ;({ getAuth } = await import('./auth'))
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    await db.execute(sql`DELETE FROM audit_events WHERE actor_name IN ('Demo Probe', ${EMAIL})`)
    await clean()
    await pool.end()
  })

  it('signs in with the hand-written credential', async () => {
    vi.stubEnv('PRINTBENCH_DEMO', '1')
    const result = await getAuth().api.signInEmail({ body: { email: EMAIL, password: PASSWORD } })
    expect(result.user.email).toBe(EMAIL)
  })

  it('refuses sign-up on a demo', async () => {
    vi.stubEnv('PRINTBENCH_DEMO', '1')
    await expect(
      getAuth().api.signUpEmail({
        body: { name: 'Intruder', email: 'demo-signup@example.test', password: 'long-enough-pw' },
      }),
    ).rejects.toThrow('Not available in the demo.')
    const rows = await db.execute(
      sql`SELECT 1 FROM "user" WHERE email = 'demo-signup@example.test'`,
    )
    expect(rows.rows).toHaveLength(0)
  })

  it('refuses a password change on a demo', async () => {
    vi.stubEnv('PRINTBENCH_DEMO', '1')
    const signedIn = await getAuth().api.signInEmail({
      body: { email: EMAIL, password: PASSWORD },
      returnHeaders: true,
    })
    const cookie = signedIn.headers.get('set-cookie')?.split(';')[0] ?? ''
    await expect(
      getAuth().api.changePassword({
        headers: new Headers({ cookie }),
        body: { currentPassword: PASSWORD, newPassword: 'locked-everyone-out' },
      }),
    ).rejects.toThrow('Not available in the demo.')
  })
})
