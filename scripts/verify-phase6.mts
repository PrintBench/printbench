/**
 * End-to-end check of phase 6: uploads, metadata editing and the sidecar.
 *
 *   npx tsx scripts/verify-phase6.mts
 */
import { createHmac } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import * as tus from 'tus-js-client'
import { loadRootEnv, parseSidecar } from '@pm/core'
import { createDb } from '@pm/db'
import { JobQueue } from '@pm/jobs'
import { cube, sphere, toBinaryStl } from '../packages/mesh/src/__fixtures__/shapes'

loadRootEnv()

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000'
const JSON_HEADERS = { 'content-type': 'application/json', origin: BASE }
const EMAIL = 'phase6-verify@example.test'
const PASSWORD = 'verify-only-throwaway-passphrase'
const MANAGED_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa'
const INPLACE_ID = '66666666-7777-4888-8999-bbbbbbbbbbbb'

const { pool, db } = createDb()
const queue = new JobQueue()

let passed = 0
let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  ok ? passed++ : failed++
}
const section = (title: string) => console.log(`\n== ${title} ==`)

let managedRoot = ''
let inPlaceRoot = ''

async function cleanup() {
  await db.execute(sql`DELETE FROM libraries WHERE id IN (${MANAGED_ID}, ${INPLACE_ID})`)
  await db.execute(sql`DELETE FROM "user" WHERE email = ${EMAIL}`)
  // updateModel creates these on demand; leaving them behind collides with
  // other suites, because creators and tags are unique on lower(name).
  await db.execute(sql`DELETE FROM creators WHERE lower(name) = 'loot studios'`)
  await db.execute(sql`DELETE FROM tags WHERE lower(name) IN ('dragon', 'miniature')`)
  for (const root of [managedRoot, inPlaceRoot]) {
    if (root) await rm(path.dirname(root), { recursive: true, force: true })
  }
}

async function waitFor<T>(probe: () => Promise<T | null>, label: string, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== null) return value
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

/** Uploads one buffer through the real tus endpoint. */
function upload(
  endpoint: string,
  data: Buffer,
  metadata: Record<string, string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const instance = new tus.Upload(data, {
      endpoint: `${BASE}${endpoint}`,
      chunkSize: 256 * 1024,
      retryDelays: [],
      metadata,
      onError: reject,
      onSuccess: () => resolve(),
    })
    instance.start()
  })
}

try {
  await cleanup()
  await queue.start()

  const base = await mkdtemp(path.join(tmpdir(), 'pm-p6-'))
  managedRoot = path.join(base, 'managed')
  inPlaceRoot = path.join(base, 'in-place')

  section('Set up')
  await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name: 'Phase Six Verify', email: EMAIL, password: PASSWORD }),
  })
  await db.execute(sql`UPDATE "user" SET role = 'admin' WHERE email = ${EMAIL}`)
  const signIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  const cookie = (signIn.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
  const get = (p: string) => fetch(`${BASE}${p}`, { headers: { cookie }, redirect: 'manual' })
  const text = async (p: string) =>
    (await (await get(p)).text()).replace(/<!--.*?-->/g, '').replace(/\s+/g, ' ')
  check('signed in', cookie.length > 0)

  const { mkdir } = await import('node:fs/promises')
  await mkdir(managedRoot, { recursive: true })
  await mkdir(inPlaceRoot, { recursive: true })

  await db.execute(sql`
    INSERT INTO libraries (id, name, kind, backend, path, write_sidecar) VALUES
      (${MANAGED_ID}, 'Uploads', 'managed', 'local', ${managedRoot}, true),
      (${INPLACE_ID}, 'Read Only', 'in_place', 'local', ${inPlaceRoot}, true)
  `)
  check('managed and in-place libraries created', true)

  section('Upload page')
  const page = await text('/upload')
  check('upload page renders', page.includes('Drop files or folders here'))
  check('offers the managed library', page.includes('Uploads') || page.includes('Upload to'))

  section('Resumable upload into a managed library')
  const secret = process.env.BETTER_AUTH_SECRET!
  const expires = Date.now() + 3_600_000
  const token = createHmac('sha256', secret)
    .update(`upload:${MANAGED_ID}:${expires}`)
    .digest('hex')
  const endpoint = `/api/upload?library=${MANAGED_ID}&expires=${expires}&token=${token}`

  const bodyStl = toBinaryStl(sphere(12, 24, 16))
  await upload(endpoint, bodyStl, {
    libraryId: MANAGED_ID,
    relativePath: 'Uploaded Dragon/stl/body.stl',
    filename: 'body.stl',
  })
  check('upload completes', true, `${bodyStl.length} bytes`)

  const landed = path.join(managedRoot, 'Uploaded Dragon', 'stl', 'body.stl')
  const info = await stat(landed).catch(() => null)
  check('file landed at the right path', info !== null, 'Uploaded Dragon/stl/body.stl')
  check('file is byte-for-byte intact', info?.size === bodyStl.length,
    `${info?.size ?? 0}/${bodyStl.length}`)

  // Folder structure is what the scanner uses to group files into models.
  const cubeStl = toBinaryStl(cube(30))
  await upload(endpoint, cubeStl, {
    libraryId: MANAGED_ID,
    relativePath: 'Uploaded Dragon/presupported/body_sup.stl',
    filename: 'body_sup.stl',
  })
  check('a second file into the same folder', true)

  section('Uploads are indexed automatically')
  const model = await waitFor(async () => {
    const r = await db.execute<{ id: string; public_id: string; name: string; file_count: number }>(sql`
      SELECT id, public_id, name, file_count FROM models
      WHERE library_id = ${MANAGED_ID} AND missing_at IS NULL LIMIT 1`)
    return r.rows[0] ?? null
  }, 'the uploaded model to be indexed')

  check('a model was created', model.name === 'Uploaded Dragon', model.name)
  const withBoth = await waitFor(async () => {
    const r = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM model_files f JOIN models m ON m.id = f.model_id
      WHERE m.library_id = ${MANAGED_ID} AND f.missing_at IS NULL`)
    return (r.rows[0]?.n ?? 0) >= 2 ? r.rows[0]! : null
  }, 'both files to be indexed')
  check('both files indexed', withBoth.n >= 2, `${withBoth.n} files`)

  const supported = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM model_files f JOIN models m ON m.id = f.model_id
    WHERE m.library_id = ${MANAGED_ID} AND f.presupported = true`)
  check('pre-supported file detected from its folder', (supported.rows[0]?.n ?? 0) === 1)

  section('Uploads are refused where they should be')
  const roExpires = Date.now() + 3_600_000
  const roToken = createHmac('sha256', secret)
    .update(`upload:${INPLACE_ID}:${roExpires}`)
    .digest('hex')
  // The token is valid; the library is simply read-only. Nothing must be written.
  await upload(
    `/api/upload?library=${INPLACE_ID}&expires=${roExpires}&token=${roToken}`,
    toBinaryStl(cube(10)),
    { libraryId: INPLACE_ID, relativePath: 'sneaky.stl', filename: 'sneaky.stl' },
  ).catch(() => {})
  await new Promise((r) => setTimeout(r, 1500))
  const sneaky = await stat(path.join(inPlaceRoot, 'sneaky.stl')).catch(() => null)
  check('nothing written into a read-only library', sneaky === null)

  const badToken = await fetch(
    `${BASE}/api/upload?library=${MANAGED_ID}&expires=${expires}&token=deadbeef`,
    { method: 'POST', headers: { 'tus-resumable': '1.0.0', 'upload-length': '10' } },
  )
  check('an invalid token is refused', badToken.status === 403, `HTTP ${badToken.status}`)

  section('Metadata editing')
  const edit = await fetch(`${BASE}/models/${model.public_id}`, { headers: { cookie } })
  check('model page renders', edit.status === 200)

  const { updateModel } = await import('@pm/core')
  const result = await updateModel(db, model.id, {
    name: 'Uploaded Dragon Knight',
    notes: 'Arrived by upload',
    license: 'CC-BY-4.0',
    creator: 'Loot Studios',
    tags: ['dragon', 'miniature'],
  })
  check('metadata saved', result.ok)
  check('sidecar written', result.sidecarWritten)

  const stored = await db.execute<{ name: string; license: string; creator: string; tags: string[] }>(sql`
    SELECT m.name, m.license, c.name AS creator,
           (SELECT array_agg(t.name ORDER BY t.name) FROM model_tags mt
              JOIN tags t ON t.id = mt.tag_id WHERE mt.model_id = m.id) AS tags
    FROM models m LEFT JOIN creators c ON c.id = m.creator_id WHERE m.id = ${model.id}`)
  check('name updated', stored.rows[0]?.name === 'Uploaded Dragon Knight')
  check('creator created and linked', stored.rows[0]?.creator === 'Loot Studios')
  check('tags applied', (stored.rows[0]?.tags ?? []).join(',') === 'dragon,miniature')

  const searchable = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM models
    WHERE id = ${model.id}
      AND search_vector @@ websearch_to_tsquery('pm_search', 'loot studios')`)
  check('search vector rebuilt on save', (searchable.rows[0]?.n ?? 0) === 1)

  section('Sidecar on disk')
  const sidecarFile = path.join(managedRoot, 'Uploaded Dragon', '.printmanager.json')
  const sidecarText = await readFile(sidecarFile, 'utf8').catch(() => null)
  check('sidecar file exists', sidecarText !== null)

  const { data: sidecar } = parseSidecar(sidecarText ?? '')
  check('sidecar carries the creator', sidecar?.creator === 'Loot Studios')
  check('sidecar carries the tags', (sidecar?.tags ?? []).join(',') === 'dragon,miniature')
  check('sidecar carries the licence', sidecar?.license === 'CC-BY-4.0')

  const asFile = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM model_files f JOIN models m ON m.id = f.model_id
    WHERE m.library_id = ${MANAGED_ID} AND f.filename LIKE '%printmanager%'`)
  check('the sidecar is never indexed as a model file', (asFile.rows[0]?.n ?? 0) === 0)

  section('Restore drill: lose the database, rescan, get it back')
  await db.execute(sql`DELETE FROM models WHERE library_id = ${MANAGED_ID}`)
  const emptied = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM models WHERE library_id = ${MANAGED_ID}`)
  check('models deleted', (emptied.rows[0]?.n ?? -1) === 0)

  const { LocalAdapter, scanLibrary } = await import('@pm/core')
  const location = {
    id: MANAGED_ID,
    kind: 'managed' as const,
    backend: 'local' as const,
    allowWrites: true,
    path: managedRoot,
  }
  const rescan = await scanLibrary(
    { db, storage: new LocalAdapter(location), library: location },
    { mode: 'deep' },
  )
  check('rescan succeeds', rescan.status === 'succeeded', rescan.abortReason ?? '')
  check('metadata restored from disk', rescan.sidecarsRestored > 0, `${rescan.sidecarsRestored}`)

  const restored = await db.execute<{ name: string; creator: string; tags: string[] }>(sql`
    SELECT m.name, c.name AS creator,
           (SELECT array_agg(t.name ORDER BY t.name) FROM model_tags mt
              JOIN tags t ON t.id = mt.tag_id WHERE mt.model_id = m.id) AS tags
    FROM models m LEFT JOIN creators c ON c.id = m.creator_id
    WHERE m.library_id = ${MANAGED_ID}`)
  check('name came back', restored.rows[0]?.name === 'Uploaded Dragon Knight', restored.rows[0]?.name)
  check('creator came back', restored.rows[0]?.creator === 'Loot Studios')
  check('tags came back', (restored.rows[0]?.tags ?? []).join(',') === 'dragon,miniature')
} catch (error) {
  console.error('\nUNEXPECTED ERROR:', error)
  failed++
} finally {
  section('Cleanup')
  await cleanup()
  check('throwaway data removed', true)
  await queue.stop()
  await pool.end()
  console.log(`\n${passed} passed, ${failed} failed\n`)
  process.exit(failed > 0 ? 1 : 0)
}
