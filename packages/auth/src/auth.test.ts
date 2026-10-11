import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDb } from '@pb/db'

/**
 * Verifies our hand-written auth schema actually satisfies better-auth at
 * runtime. The @better-auth/cli lags the library version, so its generated
 * output is not authoritative — signing a real user up is.
 */
const url = process.env.DATABASE_URL

const EMAIL = 'schema-probe@example.test'

describe('better-auth schema compatibility', { tags: ['integration'] }, () => {
  let pool: ReturnType<typeof createDb>['pool']
  let db: ReturnType<typeof createDb>['db']
  let getAuth: typeof import('./auth').getAuth
  const startedAt = new Date()

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET ??= 'test-secret-at-least-32-chars-long-xx'
    process.env.BETTER_AUTH_URL ??= 'http://localhost:3000'
    ;({ pool, db } = createDb(url))
    await db.execute(sql`DELETE FROM "user" WHERE email = ${EMAIL}`)
    ;({ getAuth } = await import('./auth'))
  })

  afterAll(async () => {
    await db.execute(sql`
      DELETE FROM audit_events
      WHERE actor_name IN ('Schema Probe', ${EMAIL})
         OR (actor_name = '(not an email address)'
             AND occurred_at >= ${startedAt.toISOString()}::timestamptz)`)
    await db.execute(sql`DELETE FROM "user" WHERE email = ${EMAIL}`)
    await pool.end()
  })

  it('signs a user up, writing user and account rows', async () => {
    const result = await getAuth().api.signUpEmail({
      body: { name: 'Schema Probe', email: EMAIL, password: 'correct-horse-battery' },
    })
    expect(result.user.email).toBe(EMAIL)

    const users = await db.execute<{ id: string; role: string }>(
      sql`SELECT id, role FROM "user" WHERE email = ${EMAIL}`,
    )
    expect(users.rows).toHaveLength(1)
    // The default from the admin plugin must land in our column.
    expect(users.rows[0]?.role).toBe('viewer')

    // A credentials account row carrying the password hash must exist.
    const accounts = await db.execute<{ provider_id: string; password: string | null }>(
      sql`SELECT provider_id, password FROM account WHERE user_id = ${users.rows[0]!.id}`,
    )
    expect(accounts.rows).toHaveLength(1)
    expect(accounts.rows[0]?.provider_id).toBe('credential')
    expect(accounts.rows[0]?.password).toBeTruthy()
    // Never stored in the clear.
    expect(accounts.rows[0]?.password).not.toContain('correct-horse-battery')
  })

  it('signs the user in and creates a session', async () => {
    const result = await getAuth().api.signInEmail({
      body: { email: EMAIL, password: 'correct-horse-battery' },
    })
    expect(result.user.email).toBe(EMAIL)

    const sessions = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM session s
      JOIN "user" u ON u.id = s.user_id WHERE u.email = ${EMAIL}
    `)
    expect(sessions.rows[0]?.n).toBeGreaterThan(0)
  })

  it('rejects a wrong password', async () => {
    await expect(
      getAuth().api.signInEmail({ body: { email: EMAIL, password: 'not-the-password' } }),
    ).rejects.toThrow()
  })

  it('records the sign-in and the refused attempt in the audit trail', async () => {
    const events = await db.execute<{
      action: string
      outcome: string
      actor_type: string
      actor_id: string | null
      actor_name: string | null
    }>(sql`
      SELECT action, outcome, actor_type, actor_id, actor_name FROM audit_events
      WHERE actor_name IN ('Schema Probe', ${EMAIL}) ORDER BY occurred_at`)

    const login = events.rows.find((event) => event.action === 'auth.login')
    expect(login).toMatchObject({
      outcome: 'success',
      actor_type: 'user',
      actor_name: 'Schema Probe',
    })
    expect(login?.actor_id).toBeTruthy()

    // The refused attempt names the address that was tried, and nobody's account.
    const refused = events.rows.find((event) => event.action === 'auth.login_failed')
    expect(refused).toMatchObject({
      outcome: 'failure',
      actor_type: 'anonymous',
      actor_id: null,
      actor_name: EMAIL,
    })
  })

  it('keeps a mistyped password out of the audit trail', async () => {
    await expect(
      getAuth().api.signInEmail({
        body: { email: 'hunter2-not-an-email', password: 'whatever-it-is' },
      }),
    ).rejects.toThrow()

    const leaked = await db.execute(
      sql`SELECT 1 FROM audit_events WHERE actor_name = 'hunter2-not-an-email'`,
    )
    expect(leaked.rows).toHaveLength(0)
  })

  it('enforces the minimum password length', async () => {
    await expect(
      getAuth().api.signUpEmail({
        body: { name: 'Too Short', email: 'short@example.test', password: 'short' },
      }),
    ).rejects.toThrow()
  })
})
