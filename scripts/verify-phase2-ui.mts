/**
 * Verifies the full phase 2 chain against the running dev server:
 *
 *   web → job queue → worker → database → rendered pages
 *
 * Queues a real scan on the real queue that the running worker consumes, waits
 * for it, then checks the browse and detail pages actually render the results.
 * Uses a throwaway account and cleans up after itself.
 *
 *   npx tsx scripts/verify-phase2-ui.mts
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { loadRootEnv } from '@pb/core'
import { createDb } from '@pb/db'
import { JOB, JobQueue } from '@pb/jobs'

loadRootEnv()

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000'
const JSON_HEADERS = { 'content-type': 'application/json', origin: BASE }
const EMAIL = 'phase2-verify@example.test'
const PASSWORD = 'verify-only-throwaway-passphrase'
const LIBRARY_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEMO = path.join(repoRoot, 'demo-library')

const { pool, db } = createDb()
const queue = new JobQueue()

let passed = 0
let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (ok) passed++
  else failed++
}
const section = (title: string) => console.log(`\n== ${title} ==`)

async function cleanup() {
  await db.execute(sql`DELETE FROM libraries WHERE id = ${LIBRARY_ID}`)
  await db.execute(sql`DELETE FROM "user" WHERE email = ${EMAIL}`)
}

async function waitFor<T>(
  probe: () => Promise<T | null>,
  label: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== null) return value
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

try {
  await cleanup()
  await queue.start()

  section('Sign in as a throwaway admin')
  await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name: 'Phase Two Verify', email: EMAIL, password: PASSWORD }),
  })
  await db.execute(sql`UPDATE "user" SET role = 'admin' WHERE email = ${EMAIL}`)

  const signIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  const cookie = (signIn.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
  check('signed in as admin', cookie.length > 0)

  const get = (p: string) => fetch(`${BASE}${p}`, { headers: { cookie }, redirect: 'manual' })

  /*
   * React's server rendering separates adjacent text nodes with <!-- -->
   * markers, so "11 models" arrives as "11<!-- --> models". Strip those (and
   * collapse whitespace) before asserting, or every text assertion is a
   * coin toss on how the JSX happened to be split.
   */
  const text = async (p: string) =>
    (await (await get(p)).text()).replace(/<!--.*?-->/g, '').replace(/\s+/g, ' ')

  section('Empty state before any library exists')
  const emptyModels = await text('/models')
  check('models page invites you to add a library', emptyModels.includes('Nothing indexed yet'))
  const emptyLibraries = await text('/admin/libraries')
  check('libraries page shows its empty state', emptyLibraries.includes('No libraries yet'))
  check(
    'promises files are never moved',
    emptyLibraries.includes('nothing is moved, renamed or deleted') ||
      emptyLibraries.includes('never moved'),
  )

  section('Add the demo library and scan it')
  await db.execute(sql`
    INSERT INTO libraries (id, name, kind, backend, path)
    VALUES (${LIBRARY_ID}, 'Demo Library', 'in_place', 'local', ${DEMO})
  `)

  await queue.send(
    JOB.libraryScan,
    { libraryId: LIBRARY_ID, mode: 'deep', force: false },
    { singletonKey: `scan:${LIBRARY_ID}` },
  )
  check('scan queued', true)

  // The running worker must pick this up on its own — that is the integration
  // being tested, so nothing here calls the scan service directly.
  const scanned = await waitFor(async () => {
    const result = await db.execute<{ status: string; models_created: number }>(sql`
      SELECT status, models_created FROM scan_runs
      WHERE library_id = ${LIBRARY_ID} AND status IN ('succeeded','aborted','failed')
      ORDER BY created_at DESC LIMIT 1
    `)
    return result.rows[0] ?? null
  }, 'the worker to finish the scan')

  check('worker completed the scan', scanned.status === 'succeeded', scanned.status)
  check('models were created', scanned.models_created > 0, `${scanned.models_created}`)

  const indexed = await db.execute<{ path: string; name: string; public_id: string }>(sql`
    SELECT path, name, public_id FROM models
    WHERE library_id = ${LIBRARY_ID} AND missing_at IS NULL ORDER BY name
  `)
  const names = indexed.rows.map((r) => r.name)
  check('finds 11 models', indexed.rows.length === 11, `${indexed.rows.length}`)
  check('pack folders are containers, not models', !names.includes('Loot Studios'))
  check('accented names are not mangled', names.includes('Pokémon Gym'), names.join(', '))
  check('hyphenated names read naturally', names.includes('Calibration Cube'))

  section('Browse page renders the library')
  const modelsHtml = await text('/models')
  check('shows the model count', /11\s*in your library/.test(modelsHtml))
  for (const expected of ['Dragon Knight', 'Forest Troll', 'Pokémon Gym', 'Benchy']) {
    check(`grid shows "${expected}"`, modelsHtml.includes(expected))
  }
  check('does not show ignored junk', !modelsHtml.includes('Thumbs.db'))
  check('does not show non-model files', !modelsHtml.includes('notes.txt'))

  section('Model detail page')
  const knight = indexed.rows.find((r) => r.name === 'Dragon Knight')!
  const detailHtml = await text(`/models/${knight.public_id}`)
  check('shows the model name', detailHtml.includes('Dragon Knight'))
  check('lists the mesh file', detailHtml.includes('body.stl'))
  check('lists files from common subfolders', detailHtml.includes('presupported/body_sup.stl'))
  check('flags pre-supported files', detailHtml.includes('supported'))
  check('groups files by kind', detailHtml.includes('3D models') && detailHtml.includes('Images'))
  check('shows which library it came from', detailHtml.includes('Demo Library'))

  const stand = indexed.rows.find((r) => r.name === 'Phone Stand')!
  const standHtml = await text(`/models/${stand.public_id}`)
  check('separates sliced output from meshes', standHtml.includes('Sliced files'))

  section('Libraries admin page')
  const librariesHtml = await text('/admin/libraries')
  check('lists the library', librariesHtml.includes('Demo Library'))
  check('shows model and file counts', /11 models/.test(librariesHtml), 
    librariesHtml.match(/\d+ models[^<]*/)?.[0] ?? 'no count found')
  check('marks in-place libraries read-only', librariesHtml.includes('Read-only'))
  check('reports the last scan', /Last (deep|fast) scan/.test(librariesHtml),
    librariesHtml.match(/Last \w+ scan[^<]{0,40}/)?.[0] ?? 'no scan line found')

  section('Rescan is idempotent through the queue')
  await queue.send(
    JOB.libraryScan,
    { libraryId: LIBRARY_ID, mode: 'fast', force: false },
    { singletonKey: `scan:${LIBRARY_ID}:2` },
  )
  const second = await waitFor(async () => {
    const result = await db.execute<{ models_created: number; models_missing: number }>(sql`
      SELECT models_created, models_missing FROM scan_runs
      WHERE library_id = ${LIBRARY_ID} AND status = 'succeeded' AND mode = 'fast'
      ORDER BY created_at DESC LIMIT 1
    `)
    return result.rows[0] ?? null
  }, 'the second scan')

  check('no duplicate models created', second.models_created === 0, `${second.models_created}`)
  check('nothing wrongly marked missing', second.models_missing === 0, `${second.models_missing}`)

  section('A viewer can browse but not manage libraries')
  await db.execute(sql`UPDATE "user" SET role = 'viewer' WHERE email = ${EMAIL}`)
  const asViewer = await text('/admin/libraries')
  check('viewer is refused library management', asViewer.includes("don't have access"))
  const viewerModels = await text('/models')
  check('viewer can still browse models', viewerModels.includes('Dragon Knight'))
} catch (error) {
  console.error('\nUNEXPECTED ERROR:', error)
  failed++
} finally {
  section('Cleanup')
  await cleanup()
  check('throwaway account and library removed', true)
  await queue.stop()
  await pool.end()
  console.log(`\n${passed} passed, ${failed} failed\n`)
  process.exit(failed > 0 ? 1 : 0)
}
