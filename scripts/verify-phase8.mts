/**
 * End-to-end check of phase 8: health, settings, schedules, sharing, prune.
 *
 *   npx tsx scripts/verify-phase8.mts
 *
 * Needs a running dev server for the page and share-link checks.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import {
  DEFAULT_SETTINGS,
  LocalAdapter,
  cronProblem,
  detectProblems,
  getSettings,
  isScanDue,
  listProblems,
  loadRootEnv,
  modelByShareToken,
  nextRun,
  problemSummary,
  prune,
  resetSetting,
  scanLibrary,
  shareModel,
  shareTokenCoversFile,
  unshareModel,
  updateSettings,
  type LibraryLocation,
} from '@pb/core'
import { createDb } from '@pb/db'

loadRootEnv()

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000'
const JSON_HEADERS = { 'content-type': 'application/json', origin: BASE }
const EMAIL = 'phase8-verify@example.test'
const PASSWORD = 'verify-only-throwaway-passphrase'
const LIBRARY_ID = '88880000-0000-4000-8000-000000000001'
const DEAD_LIBRARY_ID = '88880000-0000-4000-8000-000000000002'

const { pool, db } = createDb()

let passed = 0
let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (ok) passed++
  else failed++
}
const section = (title: string) => console.log(`\n== ${title} ==`)

let libraryRoot = ''

async function cleanup() {
  await db.execute(sql`DELETE FROM libraries WHERE id IN (${LIBRARY_ID}, ${DEAD_LIBRARY_ID})`)
  await db.execute(sql`DELETE FROM "user" WHERE email = ${EMAIL}`)
  await db.execute(sql`DELETE FROM settings`)
  await db.execute(sql`DELETE FROM creators WHERE lower(name) = 'phase eight studios'`)
  if (libraryRoot) await rm(path.dirname(libraryRoot), { recursive: true, force: true })
}

try {
  await cleanup()

  section('Set up')
  const base = await mkdtemp(path.join(tmpdir(), 'pb-p8-'))
  libraryRoot = path.join(base, 'library')

  // Three models: one complete, one with nothing filled in, one nested inside
  // the first — which is a problem the health report should notice.
  await mkdir(path.join(libraryRoot, 'Complete Model'), { recursive: true })
  await mkdir(path.join(libraryRoot, 'Complete Model', 'Nested Inside'), { recursive: true })
  await mkdir(path.join(libraryRoot, 'Bare Model'), { recursive: true })

  const stl = Buffer.concat([Buffer.alloc(80), Buffer.alloc(4)])
  await writeFile(path.join(libraryRoot, 'Complete Model', 'complete.stl'), stl)
  await writeFile(path.join(libraryRoot, 'Complete Model', 'Nested Inside', 'nested.stl'), stl)
  await writeFile(path.join(libraryRoot, 'Bare Model', 'bare.stl'), stl)

  await db.execute(sql`
    INSERT INTO libraries (id, name, kind, backend, path, grouping_mode)
    VALUES (${LIBRARY_ID}, 'Phase Eight Verify', 'in_place', 'local', ${libraryRoot}, 'deepest')`)

  const location: LibraryLocation = {
    id: LIBRARY_ID,
    kind: 'in_place',
    backend: 'local',
    allowWrites: false,
    path: libraryRoot,
  }
  const scan = await scanLibrary(
    { db, storage: new LocalAdapter(location), library: location },
    { mode: 'deep' },
  )
  check('library scanned', scan.status === 'succeeded', scan.abortReason ?? '')

  await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name: 'Phase Eight Verify', email: EMAIL, password: PASSWORD }),
  })
  await db.execute(sql`UPDATE "user" SET role = 'admin' WHERE email = ${EMAIL}`)
  const signIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  const cookie = (signIn.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
  const text = async (p: string) =>
    (await (await fetch(`${BASE}${p}`, { headers: { cookie }, redirect: 'manual' })).text())
      .replace(/<!--.*?-->/g, '')
      .replace(/\s+/g, ' ')
  check('signed in', cookie.length > 0)

  section('Library health')
  const detected = await detectProblems(db, { libraryId: LIBRARY_ID })
  check('problems detected', detected.raised > 0, `${detected.raised} raised`)

  const problems = await listProblems(db, { libraryId: LIBRARY_ID })
  const kinds = new Set(problems.map((p) => p.kind))
  check('notices missing metadata', kinds.has('no_license') && kinds.has('no_creator'))
  check('notices a model nested inside another', kinds.has('nested_model'))

  const summary = await problemSummary(db, LIBRARY_ID)
  check('summarises by kind', summary.length > 0, `${summary.length} kinds`)

  // The behaviour that keeps the dashboard worth reading.
  await db.execute(sql`
    UPDATE models SET license = 'CC-BY-4.0' WHERE library_id = ${LIBRARY_ID}`)
  const recheck = await detectProblems(db, { libraryId: LIBRARY_ID })
  check('clears a problem once it is fixed', recheck.resolved > 0, `${recheck.resolved} resolved`)

  const stillOpen = await listProblems(db, { libraryId: LIBRARY_ID, kind: 'no_license' })
  check('and stops listing it', stillOpen.length === 0)

  const secondPass = await detectProblems(db, { libraryId: LIBRARY_ID })
  check('is idempotent', secondPass.raised === 0 && secondPass.resolved === 0)

  const healthPage = await text('/admin/health')
  check('health page renders', healthPage.includes('Library health'))

  section('Settings')
  const defaults = await getSettings(db)
  check('defaults apply with nothing stored', defaults.siteName === DEFAULT_SETTINGS.siteName)

  await updateSettings(db, { siteName: 'Phase Eight Workshop', missingGraceDays: 7 })
  const saved = await getSettings(db)
  check('settings round-trip', saved.siteName === 'Phase Eight Workshop')
  check('and keep untouched defaults', saved.publicSharing === DEFAULT_SETTINGS.publicSharing)

  let rejected = false
  try {
    await updateSettings(db, { missingGraceDays: 0 })
  } catch {
    rejected = true
  }
  check('refuses a grace period that would delete metadata at once', rejected)

  const shell = await text('/')
  check('the configured name reaches the shell', shell.includes('Phase Eight Workshop'))

  await resetSetting(db, 'siteName')
  check('resets to the default', (await getSettings(db)).siteName === DEFAULT_SETTINGS.siteName)

  section('Scan schedules')
  check('accepts a preset', cronProblem('0 3 * * *') === null)
  check('refuses a schedule that would scan constantly', cronProblem('* * * * *') !== null)
  check('reports the next run', nextRun('0 3 * * *') instanceof Date)
  check('a never-scanned library is due at once', isScanDue('0 3 * * *', null))
  check('a just-scanned library is not', !isScanDue('0 3 * * *', new Date(), new Date()))

  section('Share links')
  const model = await db.execute<{ id: string; public_id: string }>(sql`
    SELECT id, public_id FROM models WHERE library_id = ${LIBRARY_ID}
      AND name = 'Bare Model' LIMIT 1`)
  const modelId = model.rows[0]!.id

  const file = await db.execute<{ id: string }>(sql`
    SELECT id FROM model_files WHERE model_id = ${modelId} LIMIT 1`)
  const fileId = file.rows[0]!.id

  const otherFile = await db.execute<{ id: string }>(sql`
    SELECT f.id FROM model_files f JOIN models m ON m.id = f.model_id
    WHERE m.library_id = ${LIBRARY_ID} AND m.id <> ${modelId} LIMIT 1`)

  const { token } = await shareModel(db, modelId, 'verify')
  check('link minted', token.length >= 20)
  check('token is not the public id', token !== model.rows[0]!.public_id)

  check('resolves to the model', (await modelByShareToken(db, token))?.id === modelId)
  check('covers its own files', await shareTokenCoversFile(db, token, fileId))
  check(
    "does not cover another model's files",
    !(await shareTokenCoversFile(db, token, otherFile.rows[0]!.id)),
  )

  // The instance-wide switch, checked without a session at all.
  await updateSettings(db, { publicSharing: false })
  const closed = await fetch(`${BASE}/share/${token}`, { redirect: 'manual' })
  check('share page is closed when sharing is off', closed.status === 404, `${closed.status}`)

  await updateSettings(db, { publicSharing: true })
  const open = await fetch(`${BASE}/share/${token}`, { redirect: 'manual' })
  check('share page opens with no session when sharing is on', open.status === 200)

  const body = await open.text()
  check('and shows the model', body.includes('Bare Model'))

  const anonFile = await fetch(`${BASE}/api/share/${token}/files/${fileId}`)
  check('anonymous download works', anonFile.status === 200)

  const wrongFile = await fetch(`${BASE}/api/share/${token}/files/${otherFile.rows[0]!.id}`)
  check(
    "a share token cannot fetch another model's file",
    wrongFile.status === 404,
    `${wrongFile.status}`,
  )

  await unshareModel(db, modelId)
  const revoked = await fetch(`${BASE}/share/${token}`, { redirect: 'manual' })
  check('revoked link stops working', revoked.status === 404)

  const revokedFile = await fetch(`${BASE}/api/share/${token}/files/${fileId}`)
  check('and so do its files', revokedFile.status === 404)

  section('Prune')
  await db.execute(sql`
    INSERT INTO libraries (id, name, kind, backend, path)
    VALUES (${DEAD_LIBRARY_ID}, 'Unplugged NAS', 'in_place', 'local', '/mnt/gone')`)
  await db.execute(sql`
    INSERT INTO models (id, library_id, path, name, slug, public_id, file_count, total_size,
                        missing_at)
    VALUES (gen_random_uuid(), ${DEAD_LIBRARY_ID}, 'gone/one', 'Gone One', 'p8-gone-1',
            'md8800000001', 1, 100, now() - '90 days'::interval)`)

  // Something long gone from a library that is otherwise healthy.
  await db.execute(sql`
    UPDATE models SET missing_at = now() - '90 days'::interval
    WHERE library_id = ${LIBRARY_ID} AND name = 'Nested Inside'`)

  const dry = await prune(db, { graceDays: 30, dryRun: true })
  check('dry run reports without deleting', dry.modelsDeleted > 0, `${dry.modelsDeleted}`)

  const before = await db.execute<{ count: number }>(
    sql`SELECT count(*)::int FROM models WHERE library_id = ${DEAD_LIBRARY_ID}`,
  )

  const pruned = await prune(db, { graceDays: 30 })
  check('removes what is long gone', pruned.modelsDeleted > 0)
  check(
    'skips a library where everything is missing',
    pruned.librariesSkipped.includes('Unplugged NAS'),
  )

  const after = await db.execute<{ count: number }>(
    sql`SELECT count(*)::int FROM models WHERE library_id = ${DEAD_LIBRARY_ID}`,
  )
  check(
    'so the unplugged library is untouched',
    after.rows[0]!.count === before.rows[0]!.count,
    `${after.rows[0]!.count} models`,
  )

  const again = await prune(db, { graceDays: 30 })
  check('is safe to run twice', again.modelsDeleted === 0)
} catch (error) {
  console.error('\nUNEXPECTED ERROR:', error)
  failed++
} finally {
  section('Cleanup')
  await cleanup()
  check('throwaway data removed', true)
  await pool.end()
  console.log(`\n${passed} passed, ${failed} failed\n`)
  process.exit(failed > 0 ? 1 : 0)
}
