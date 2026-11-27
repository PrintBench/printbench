import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { like, sql } from 'drizzle-orm'
import { createDb, schema } from '@pb/db'

/**
 * PrintBench is invite-only. better-auth's own sign-up endpoint is reachable
 * by anyone at /api/auth/sign-up/email, so these prove that a request over
 * HTTP is refused while the server-side call setup and invitations rely on
 * still creates the account.
 */
const url = process.env.DATABASE_URL
const ORIGIN = 'http://localhost:3000'
const DOMAIN = '@public-sign-up.test'

describe('public sign-up', { tags: ['integration'] }, () => {
  let pool: ReturnType<typeof createDb>['pool']
  let db: ReturnType<typeof createDb>['db']
  let getAuth: typeof import('./auth').getAuth

  async function usersCreated(): Promise<string[]> {
    const rows = await db
      .select({ email: schema.user.email })
      .from(schema.user)
      .where(like(schema.user.email, `%${DOMAIN}`))
    return rows.map((row) => row.email)
  }

  function signUpRequest(path: string, body: string, contentType: string): Request {
    return new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      // A browser on the instance's own origin: the origin check is not what refuses this.
      headers: { 'content-type': contentType, origin: ORIGIN },
      body,
    })
  }

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET ??= 'test-secret-at-least-32-chars-long-xx'
    process.env.BETTER_AUTH_URL ??= ORIGIN
    ;({ pool, db } = createDb(url))
    await db.execute(sql`DELETE FROM "user" WHERE email LIKE ${`%${DOMAIN}`}`)
    ;({ getAuth } = await import('./auth'))
  })

  afterAll(async () => {
    await db.execute(sql`DELETE FROM "user" WHERE email LIKE ${`%${DOMAIN}`}`)
    await pool.end()
  })

  it.each([
    ['JSON', '/api/auth/sign-up/email', 'application/json'],
    ['a form post', '/api/auth/sign-up/email', 'application/x-www-form-urlencoded'],
  ])('refuses sign-up over HTTP (%s)', async (_label, path, contentType) => {
    const fields = { name: 'Stranger', email: `stranger${DOMAIN}`, password: 'long-enough-pass' }
    const body =
      contentType === 'application/json'
        ? JSON.stringify(fields)
        : new URLSearchParams(fields).toString()

    const response = await getAuth().handler(signUpRequest(path, body, contentType))

    // 403 specifically: a 400 would mean the body was malformed, not that sign-up was refused.
    expect(response.status).toBe(403)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(await usersCreated()).toEqual([])
  })

  it('still lets server code create an account', async () => {
    const result = await getAuth().api.signUpEmail({
      body: { name: 'Invited', email: `invited${DOMAIN}`, password: 'long-enough-pass' },
      headers: new Headers({ origin: ORIGIN }),
    })

    expect(result.user.email).toBe(`invited${DOMAIN}`)
    expect(await usersCreated()).toEqual([`invited${DOMAIN}`])
  })
})
