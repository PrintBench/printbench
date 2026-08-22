/**
 * End-to-end check of the Phase 1 authenticated surface.
 *
 * Creates a clearly-labelled throwaway account, exercises the real HTTP
 * endpoints, and asserts the role guards hold in both directions. Cleans up
 * after itself so the instance is left in first-run state for the real admin.
 *
 *   npx tsx scripts/verify-phase1.mts
 */
import { sql } from 'drizzle-orm'
import { loadRootEnv } from '@pb/core'
import { createDb } from '@pb/db'

loadRootEnv()

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000'
const EMAIL = 'phase1-verify@example.test'
const PASSWORD = 'verify-only-throwaway-passphrase'

/**
 * A browser always sends Origin. Node's fetch sends `Origin: null`, which
 * better-auth rejects as an opaque origin (a real CSRF vector), so send the
 * genuine one to exercise the same path a browser takes.
 */
const JSON_HEADERS = { 'content-type': 'application/json', origin: BASE }

const { pool, db } = createDb()
let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (ok) passed++
  else failed++
}

function section(title: string) {
  console.log(`\n== ${title} ==`)
}

async function cleanup() {
  await db.execute(sql`DELETE FROM "user" WHERE email = ${EMAIL}`)
}

/** Follows no redirects, so redirects can be asserted on. */
async function get(path: string, cookie?: string) {
  return fetch(`${BASE}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} })
}

async function signIn(): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  check('sign-in succeeds', response.ok, `HTTP ${response.status}`)
  return (response.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
}

try {
  await cleanup()

  section('First-run state (no users)')
  check(
    '/ redirects to /setup',
    (await get('/')).headers.get('location')?.includes('/setup') === true,
  )
  check(
    '/login redirects to /setup',
    (await get('/login')).headers.get('location')?.includes('/setup') === true,
  )
  check('/setup is reachable', (await get('/setup')).status === 200)

  section('Create an account via the real signup endpoint')
  const signUp = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name: 'Phase One Verify', email: EMAIL, password: PASSWORD }),
  })
  check('sign-up succeeds', signUp.ok, `HTTP ${signUp.status}`)

  const created = await db.execute<{ id: string; role: string }>(
    sql`SELECT id, role FROM "user" WHERE email = ${EMAIL}`,
  )
  check('user row exists', created.rows.length === 1)
  check(
    'new accounts default to viewer, never admin',
    created.rows[0]?.role === 'viewer',
    created.rows[0]?.role,
  )

  section('Setup closes permanently once a user exists')
  check(
    '/setup redirects to /login',
    (await get('/setup')).headers.get('location')?.includes('/login') === true,
  )
  check(
    '/ redirects to /login when signed out',
    (await get('/')).headers.get('location')?.includes('/login') === true,
  )

  section('Sign in')
  const cookie = await signIn()
  check('session cookie issued', cookie.length > 0)

  section('Authenticated pages (role: viewer)')
  const dash = await get('/', cookie)
  const dashHtml = await dash.text()
  check('dashboard renders', dash.status === 200, `HTTP ${dash.status}`)
  check('greets the user by name', dashHtml.includes('Phase'))
  check('shows the empty-library state', dashHtml.includes('No libraries yet'))
  check(
    'viewer is told an admin must add a library',
    dashHtml.includes('An admin needs to add a library'),
  )
  check('viewer is NOT offered the add-library button', !dashHtml.includes('Add a library'))

  section('Role guard (viewer)')
  const asViewer = await get('/admin/users', cookie)
  const viewerHtml = await asViewer.text()
  check('refusal is a normal page, not a 500', asViewer.status === 200, `HTTP ${asViewer.status}`)
  check(
    'viewer sees a refusal',
    viewerHtml.includes('You&#x27;t') || viewerHtml.includes("don't have access"),
  )
  check('viewer cannot see the account list', !viewerHtml.includes('Joined'))

  // Promotion must take effect on the SAME session. If session data were cached
  // in the cookie, the role would go stale and this would fail.
  section('Promote to admin (same session, no re-login)')
  await db.execute(sql`UPDATE "user" SET role = 'admin' WHERE email = ${EMAIL}`)
  const asAdmin = await get('/admin/users', cookie)
  const adminUsersHtml = await asAdmin.text()
  check('/admin/users renders for an admin', asAdmin.status === 200, `HTTP ${asAdmin.status}`)
  check('lists the account', adminUsersHtml.includes(EMAIL))
  check('marks the current user as "You"', adminUsersHtml.includes('You'))

  const adminDashHtml = await (await get('/', cookie)).text()
  check('admin IS offered the add-library button', adminDashHtml.includes('Add a library'))

  // The direction that matters for security: revoking admin must take effect
  // immediately on an existing session, not whenever a cache happens to expire.
  section('Revoke admin (same session)')
  await db.execute(sql`UPDATE "user" SET role = 'viewer' WHERE email = ${EMAIL}`)
  const revokedHtml = await (await get('/admin/users', cookie)).text()
  check('revoked admin loses access immediately', !revokedHtml.includes('Joined'))

  section('Sign out')
  const signOut = await fetch(`${BASE}/api/auth/sign-out`, {
    method: 'POST',
    headers: { ...JSON_HEADERS, cookie },
    // Declaring a JSON content-type obliges us to send a body, as a browser does.
    body: '{}',
  })
  check('sign-out succeeds', signOut.ok, `HTTP ${signOut.status}`)
  const afterSignOut = await get('/', cookie)
  check(
    'signed-out session no longer grants access',
    (afterSignOut.headers.get('location') ?? '').includes('/login'),
    `HTTP ${afterSignOut.status}`,
  )
} finally {
  section('Cleanup')
  await cleanup()
  const left = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM "user"`)
  check('instance returned to first-run state', (left.rows[0]?.n ?? -1) === 0)
  await pool.end()
  console.log(`\n${passed} passed, ${failed} failed\n`)
  process.exit(failed > 0 ? 1 : 0)
}
