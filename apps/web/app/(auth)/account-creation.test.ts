import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq, inArray, like } from 'drizzle-orm'
import { createInvite } from '@pb/core'
import { createDb, schema } from '@pb/db'

/**
 * Public sign-up over HTTP is refused (packages/auth/src/sign-up.test.ts).
 * These run the three flows that are meant to create accounts against a real
 * database, so closing that route cannot quietly break them.
 */
const ORIGIN = 'http://localhost:3000'
const DOMAIN = '@account-creation.test'
const ADMIN = { name: 'First Admin', email: `admin${DOMAIN}`, password: 'first-admin-pass' }
const PASSWORD = 'long-enough-pass'

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  needsFirstRunSetup: vi.fn(),
}))
vi.mock('next/headers', () => ({ headers: mocks.headers }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
// The zero-users gate has its own concern; this shared database is not empty.
vi.mock('@/lib/setup', () => ({ needsFirstRunSetup: mocks.needsFirstRunSetup }))

import { createFirstAdmin } from './setup/actions'
import { acceptInvite } from './invite/[token]/actions'
import { addUser } from '../(app)/admin/users/actions'

function form(fields: Record<string, string>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(fields)) data.set(key, value)
  return data
}

describe('account creation flows', { tags: ['integration'] }, () => {
  let pool: ReturnType<typeof createDb>['pool']
  let db: ReturnType<typeof createDb>['db']
  let adminCookie = ''

  async function account(email: string) {
    const [row] = await db
      .select({ id: schema.user.id, role: schema.user.role, verified: schema.user.emailVerified })
      .from(schema.user)
      .where(eq(schema.user.email, email))
    return row
  }

  async function auditActions(actorId: string): Promise<string[]> {
    const rows = await db
      .select({ action: schema.auditEvents.action })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.actorId, actorId))
    return rows.map((row) => row.action)
  }

  async function cleanUp() {
    const ids = (
      await db
        .select({ id: schema.user.id })
        .from(schema.user)
        .where(like(schema.user.email, `%${DOMAIN}`))
    ).map((row) => row.id)
    if (ids.length === 0) return
    await db.delete(schema.auditEvents).where(inArray(schema.auditEvents.actorId, ids))
    await db.delete(schema.invitations).where(inArray(schema.invitations.createdBy, ids))
    await db.delete(schema.user).where(inArray(schema.user.id, ids))
  }

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET ??= 'test-secret-at-least-32-chars-long-xx'
    process.env.BETTER_AUTH_URL ??= ORIGIN
    ;({ pool, db } = createDb(process.env.DATABASE_URL))
    await cleanUp()
  })

  afterAll(async () => {
    await cleanUp()
    await pool.end()
  })

  /*
   * Setup and invitations also sign the new person in: better-auth issues a
   * session, and nextCookies() writes it to the server action's response.
   * better-auth loads outside Vite, so its next/headers import cannot be
   * mocked here; the session row is what that cookie carries.
   */
  async function sessionCount(userId: string): Promise<number> {
    const rows = await db
      .select({ id: schema.session.id })
      .from(schema.session)
      .where(eq(schema.session.userId, userId))
    return rows.length
  }

  beforeEach(() => {
    mocks.needsFirstRunSetup.mockResolvedValue(true)
    mocks.headers.mockResolvedValue(new Headers({ origin: ORIGIN }))
  })

  it('first-run setup creates the admin', async () => {
    expect(await createFirstAdmin(form(ADMIN))).toEqual({ ok: true })

    const admin = await account(ADMIN.email)
    expect(admin).toMatchObject({ role: 'admin', verified: true })
    expect(await sessionCount(admin!.id)).toBe(1)
    expect(await auditActions(admin!.id)).toContain('auth.setup')

    // The new admin can sign in with what they chose; keep the cookie for addUser.
    const { getAuth } = await import('@pb/auth')
    const signedIn = await getAuth().api.signInEmail({
      body: { email: ADMIN.email, password: ADMIN.password },
      headers: new Headers({ origin: ORIGIN }),
      returnHeaders: true,
    })
    adminCookie = signedIn.headers.get('set-cookie')?.split(';')[0] ?? ''
    expect(adminCookie).not.toBe('')
  })

  it('an invitation creates an account with the role it carried', async () => {
    const admin = await account(ADMIN.email)
    const { token } = await createInvite(db, { role: 'member', createdBy: admin!.id })

    const result = await acceptInvite(
      form({ token, name: 'Invited Member', email: `member${DOMAIN}`, password: PASSWORD }),
    )
    expect(result).toEqual({ ok: true })

    const member = await account(`member${DOMAIN}`)
    expect(member).toMatchObject({ role: 'member', verified: true })
    expect(await sessionCount(member!.id)).toBe(1)
    expect(await auditActions(member!.id)).toContain('user.invite_accepted')

    const [invitation] = await db
      .select({ acceptedBy: schema.invitations.acceptedBy })
      .from(schema.invitations)
      .where(eq(schema.invitations.token, token))
    expect(invitation?.acceptedBy).toBe(member!.id)
  })

  it('an admin adds a user directly', async () => {
    mocks.headers.mockResolvedValue(new Headers({ origin: ORIGIN, cookie: adminCookie }))

    const result = await addUser({
      name: 'Added Viewer',
      email: `added${DOMAIN}`,
      password: PASSWORD,
      role: 'viewer',
    })
    expect(result).toEqual({ ok: true })

    const added = await account(`added${DOMAIN}`)
    expect(added).toMatchObject({ role: 'viewer', verified: true })
    // Creating someone else's account must not sign anyone into it.
    expect(await sessionCount(added!.id)).toBe(0)
    const admin = await account(ADMIN.email)
    expect(await auditActions(admin!.id)).toContain('user.created')
  })
})
