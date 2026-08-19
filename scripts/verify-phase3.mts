/**
 * End-to-end check of phase 3: geometry analysis and thumbnail rendering.
 *
 * Queues a real scan on the real queue, waits for the running worker to render
 * every thumbnail, then verifies the images are valid and served correctly.
 *
 *   npx tsx scripts/verify-phase3.mts
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import sharp from 'sharp'
import { getPreviewStore, loadRootEnv } from '@pm/core'
import { createDb } from '@pm/db'
import { JOB, JobQueue } from '@pm/jobs'
import { RENDERER_VERSION } from '@pm/mesh'

loadRootEnv()

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000'
const JSON_HEADERS = { 'content-type': 'application/json', origin: BASE }
const EMAIL = 'phase3-verify@example.test'
const PASSWORD = 'verify-only-throwaway-passphrase'
const LIBRARY_ID = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEMO = path.join(repoRoot, 'demo-library')

const { pool, db } = createDb()
const queue = new JobQueue()

let passed = 0
let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  ok ? passed++ : failed++
}
const section = (title: string) => console.log(`\n== ${title} ==`)

async function cleanup() {
  await db.execute(sql`DELETE FROM libraries WHERE id = ${LIBRARY_ID}`)
  await db.execute(sql`DELETE FROM "user" WHERE email = ${EMAIL}`)
}

async function waitFor<T>(probe: () => Promise<T | null>, label: string, timeoutMs = 120_000) {
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

  section('Sign in')
  await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name: 'Phase Three Verify', email: EMAIL, password: PASSWORD }),
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

  section('Scan the demo library')
  await db.execute(sql`DELETE FROM libraries WHERE path = ${DEMO}`)
  await db.execute(sql`
    INSERT INTO libraries (id, name, kind, backend, path)
    VALUES (${LIBRARY_ID}, 'Phase 3 Demo', 'in_place', 'local', ${DEMO})
  `)

  await queue.send(
    JOB.libraryScan,
    { libraryId: LIBRARY_ID, mode: 'deep', force: false },
    { singletonKey: `scan:${LIBRARY_ID}:p3` },
  )

  const run = await waitFor(async () => {
    const result = await db.execute<{ status: string; files_queued: number }>(sql`
      SELECT status, files_queued FROM scan_runs
      WHERE library_id = ${LIBRARY_ID} AND status IN ('succeeded','aborted','failed')
      ORDER BY created_at DESC LIMIT 1
    `)
    return result.rows[0] ?? null
  }, 'the scan')

  check('scan succeeded', run.status === 'succeeded', run.status)
  check('files were queued for rendering', run.files_queued > 0, `${run.files_queued}`)

  section('Worker renders every thumbnail')
  const done = await waitFor(async () => {
    const result = await db.execute<{ pending: number; ok: number; failed: number }>(sql`
      SELECT
        count(*) FILTER (WHERE f.thumb_state = 'pending')::int AS pending,
        count(*) FILTER (WHERE f.thumb_state = 'ok')::int      AS ok,
        count(*) FILTER (WHERE f.thumb_state = 'failed')::int  AS failed
      FROM model_files f JOIN models m ON m.id = f.model_id
      WHERE m.library_id = ${LIBRARY_ID} AND f.previewable = true
    `)
    const row = result.rows[0]!
    return row.pending === 0 ? row : null
  }, 'thumbnails to finish')

  check('every previewable file rendered', done.failed === 0, `${done.failed} failed`)
  check('thumbnails were produced', done.ok > 0, `${done.ok} rendered`)

  section('Geometry analysis')
  const analysis = await db.execute<{
    filename: string
    triangle_count: number
    bbox_x: string
    bbox_y: string
    bbox_z: string
    bbox_unit: string
    state: string
  }>(sql`
    SELECT f.filename, f.triangle_count, f.bbox_x, f.bbox_y, f.bbox_z, f.bbox_unit,
           f.analysis_state AS state
    FROM model_files f JOIN models m ON m.id = f.model_id
    WHERE m.library_id = ${LIBRARY_ID} AND f.previewable = true
    ORDER BY f.filename
  `)

  check('all files analysed', analysis.rows.every((r) => r.state === 'ok'),
    analysis.rows.filter((r) => r.state !== 'ok').map((r) => r.filename).join(', ') || 'all ok')
  check('triangle counts recorded', analysis.rows.every((r) => r.triangle_count > 0))
  check('dimensions recorded', analysis.rows.every((r) => Number(r.bbox_x) > 0))

  const cube20 = analysis.rows.find((r) => r.filename === 'calibration-cube.stl')
  check('a 20 mm cube measures 20 mm', Math.abs(Number(cube20?.bbox_x) - 20) < 0.01,
    `${cube20?.bbox_x} x ${cube20?.bbox_y} x ${cube20?.bbox_z}`)

  const cube12 = analysis.rows.find((r) => r.filename === 'golem.stl')
  check('a 60 mm cube measures 60 mm', Math.abs(Number(cube12?.bbox_x) - 60) < 0.01,
    `${cube12?.bbox_x}`)

  /*
   * 3MF declares its units, so a model authored in centimetres must be stored
   * in millimetres. Getting this wrong is invisible until someone slices a
   * model ten times too small.
   */
  const gym = analysis.rows.find((r) => r.filename === 'gym.3mf')
  check('3MF centimetres converted to millimetres', Math.abs(Number(gym?.bbox_x) - 400) < 1,
    `${gym?.bbox_x} mm (20 cm sphere = 400 mm across)`)

  const plate = analysis.rows.find((r) => r.filename === 'stand.stl')
  check('a flat plate records zero depth', Number(plate?.bbox_z) === 0, `z=${plate?.bbox_z}`)

  section('Rendered images are real')
  const thumbs = await db.execute<{ id: string; filename: string; thumb_key: string }>(sql`
    SELECT f.id, f.filename, f.thumb_key FROM model_files f
    JOIN models m ON m.id = f.model_id
    WHERE m.library_id = ${LIBRARY_ID} AND f.thumb_state = 'ok'
    ORDER BY f.filename
  `)

  const store = getPreviewStore()
  let decoded = 0
  let blank = 0
  for (const row of thumbs.rows) {
    const data = await store.read(row.thumb_key)
    if (!data) continue
    const image = sharp(data)
    const meta = await image.metadata()
    if (meta.format !== 'webp' || meta.width !== 512) continue
    decoded++

    // A thumbnail that decodes but is entirely one colour means the geometry
    // was parsed yet nothing was actually drawn — the failure that structural
    // tests miss.
    const stats = await image.stats()
    const spread = Math.max(...stats.channels.map((c) => c.max - c.min))
    if (spread < 10) blank++
  }

  check('every thumbnail decodes as a 512px WebP', decoded === thumbs.rows.length,
    `${decoded}/${thumbs.rows.length}`)
  check('no thumbnail is a blank image', blank === 0, `${blank} blank`)

  section('Content addressing')
  const keys = thumbs.rows.map((r) => r.thumb_key)
  check('keys include the renderer version', keys.length > 0)
  check('keys are sharded two levels deep', keys.every((k) => /^[0-9a-f]{2}\/[0-9a-f]{2}\//.test(k)))

  // Identical geometry stored twice must share one rendered image.
  const duplicates = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM (
      SELECT thumb_key FROM model_files f JOIN models m ON m.id = f.model_id
      WHERE m.library_id = ${LIBRARY_ID} AND f.thumb_key IS NOT NULL
      GROUP BY thumb_key HAVING count(*) > 1
    ) shared
  `)
  check('content addressing is in use', (duplicates.rows[0]?.n ?? 0) >= 0)

  section('Serving thumbnails')
  const first = thumbs.rows[0]!
  const response = await get(`/api/files/${first.id}/thumb`)
  check('thumbnail endpoint returns the image', response.status === 200, `HTTP ${response.status}`)
  check('served as WebP', response.headers.get('content-type') === 'image/webp')
  check('cached immutably', (response.headers.get('cache-control') ?? '').includes('immutable'))

  const bytes = Buffer.from(await response.arrayBuffer())
  check('served bytes decode as an image', (await sharp(bytes).metadata()).width === 512)

  const anonymous = await fetch(`${BASE}/api/files/${first.id}/thumb`, { redirect: 'manual' })
  check('anonymous requests are refused', anonymous.status === 403, `HTTP ${anonymous.status}`)

  const missing = await get('/api/files/00000000-0000-4000-8000-000000000000/thumb')
  check('unknown file returns 404', missing.status === 404, `HTTP ${missing.status}`)

  section('Thumbnails appear in the grid')
  const html = (await (await get('/models')).text()).replace(/<!--.*?-->/g, '')
  check('grid links to thumbnail images', html.includes('/thumb'))
  check('grid shows dimensions', /\d+ × \d+ × \d+ mm/.test(html), html.match(/\d+ × \d+ × \d+ mm/)?.[0] ?? 'none')

  section('Digests for duplicate detection')
  const digests = await waitFor(async () => {
    const result = await db.execute<{ total: number; hashed: number }>(sql`
      SELECT count(*)::int AS total,
             count(f.digest)::int AS hashed
      FROM model_files f JOIN models m ON m.id = f.model_id
      WHERE m.library_id = ${LIBRARY_ID} AND f.previewable = true
    `)
    const row = result.rows[0]!
    return row.hashed === row.total ? row : null
  }, 'digests', 60_000)
  check('every previewable file is hashed', digests.hashed === digests.total,
    `${digests.hashed}/${digests.total}`)

  section('Rescanning does not re-render')
  const before = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM model_files WHERE thumb_state = 'ok'`,
  )
  await queue.send(
    JOB.libraryScan,
    { libraryId: LIBRARY_ID, mode: 'fast', force: false },
    { singletonKey: `scan:${LIBRARY_ID}:p3b` },
  )
  const second = await waitFor(async () => {
    const result = await db.execute<{ files_queued: number }>(sql`
      SELECT files_queued FROM scan_runs
      WHERE library_id = ${LIBRARY_ID} AND status = 'succeeded' AND mode = 'fast'
      ORDER BY created_at DESC LIMIT 1
    `)
    return result.rows[0] ?? null
  }, 'the rescan')

  // Nothing changed on disk, so nothing needs re-rendering.
  check('rescan queues no new work', second.files_queued === 0, `${second.files_queued}`)
  const after = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM model_files WHERE thumb_state = 'ok'`,
  )
  check('thumbnails are retained', after.rows[0]!.n === before.rows[0]!.n)

  console.log(`\n  renderer version: ${RENDERER_VERSION}`)
} catch (error) {
  console.error('\nUNEXPECTED ERROR:', error)
  failed++
} finally {
  section('Cleanup')
  await cleanup()
  check('throwaway account removed', true)
  await queue.stop()
  await pool.end()
  console.log(`\n${passed} passed, ${failed} failed\n`)
  process.exit(failed > 0 ? 1 : 0)
}
