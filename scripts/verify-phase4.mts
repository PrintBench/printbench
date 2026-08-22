/**
 * End-to-end check of phase 4: file downloads, Range support and ZIP archives.
 *
 * The viewer itself is exercised in a browser; this covers everything it
 * depends on plus the download paths.
 *
 *   npx tsx scripts/verify-phase4.mts
 */
import { createHmac } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'
import { sql } from 'drizzle-orm'
import { loadRootEnv } from '@pb/core'
import { createDb } from '@pb/db'
import { JOB, JobQueue } from '@pb/jobs'

loadRootEnv()

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000'
const JSON_HEADERS = { 'content-type': 'application/json', origin: BASE }
const EMAIL = 'phase4-verify@example.test'
const PASSWORD = 'verify-only-throwaway-passphrase'
const LIBRARY_ID = 'eeeeeeee-ffff-4aaa-8bbb-cccccccccccc'

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

  section('Set up')
  await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name: 'Phase Four Verify', email: EMAIL, password: PASSWORD }),
  })
  await db.execute(sql`UPDATE "user" SET role = 'admin' WHERE email = ${EMAIL}`)
  const signIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  const cookie = (signIn.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
  const get = (p: string, headers: Record<string, string> = {}) =>
    fetch(`${BASE}${p}`, { headers: { cookie, ...headers }, redirect: 'manual' })
  check('signed in', cookie.length > 0)

  await db.execute(sql`DELETE FROM libraries WHERE path = ${DEMO}`)
  await db.execute(sql`
    INSERT INTO libraries (id, name, kind, backend, path)
    VALUES (${LIBRARY_ID}, 'Phase 4 Demo', 'in_place', 'local', ${DEMO})
  `)
  await queue.send(
    JOB.libraryScan,
    { libraryId: LIBRARY_ID, mode: 'deep', force: false },
    { singletonKey: `scan:${LIBRARY_ID}:p4` },
  )
  const run = await waitFor(async () => {
    const r = await db.execute<{ status: string }>(sql`
      SELECT status FROM scan_runs WHERE library_id = ${LIBRARY_ID}
        AND status IN ('succeeded','aborted','failed') ORDER BY created_at DESC LIMIT 1`)
    return r.rows[0] ?? null
  }, 'the scan')
  check('library scanned', run.status === 'succeeded', run.status)

  const files = await db.execute<{
    id: string
    filename: string
    size: string
    model_id: string
  }>(sql`
    SELECT f.id, f.filename, f.size, f.model_id FROM model_files f
    JOIN models m ON m.id = f.model_id
    WHERE m.library_id = ${LIBRARY_ID} AND f.extension = 'stl' AND f.size > 1000
    ORDER BY f.size DESC LIMIT 1`)
  const file = files.rows[0]!
  const fileSize = Number(file.size)
  check('found a file to download', fileSize > 1000, `${file.filename} (${fileSize} bytes)`)

  section('Whole-file download')
  const whole = await get(`/api/files/${file.id}/raw`)
  const wholeBytes = Buffer.from(await whole.arrayBuffer())
  check('returns 200', whole.status === 200, `HTTP ${whole.status}`)
  check(
    'sends the complete file',
    wholeBytes.length === fileSize,
    `${wholeBytes.length}/${fileSize}`,
  )
  check('declares its length', whole.headers.get('content-length') === String(fileSize))
  check('advertises range support', whole.headers.get('accept-ranges') === 'bytes')
  check(
    'offers a filename',
    (whole.headers.get('content-disposition') ?? '').includes('attachment'),
  )
  check('sends an etag', (whole.headers.get('etag') ?? '').length > 2)

  section('Conditional request')
  const etag = whole.headers.get('etag')!
  const cached = await get(`/api/files/${file.id}/raw`, { 'if-none-match': etag })
  check('unchanged file returns 304', cached.status === 304, `HTTP ${cached.status}`)

  section('Range requests')
  const first = await get(`/api/files/${file.id}/raw`, { range: 'bytes=0-99' })
  const firstBytes = Buffer.from(await first.arrayBuffer())
  check('partial content status', first.status === 206, `HTTP ${first.status}`)
  check('returns exactly the requested bytes', firstBytes.length === 100, `${firstBytes.length}`)
  check('content-range is correct', first.headers.get('content-range') === `bytes 0-99/${fileSize}`)
  check('bytes match the whole file', firstBytes.equals(wholeBytes.subarray(0, 100)))

  const middle = await get(`/api/files/${file.id}/raw`, { range: 'bytes=500-599' })
  const middleBytes = Buffer.from(await middle.arrayBuffer())
  check('a mid-file range is correct', middleBytes.equals(wholeBytes.subarray(500, 600)))

  /*
   * "bytes=-500" means the LAST 500 bytes. Reading it as an offset serves the
   * wrong part of the file, and for a mesh that means the viewer silently
   * renders nothing.
   */
  const suffix = await get(`/api/files/${file.id}/raw`, { range: 'bytes=-500' })
  const suffixBytes = Buffer.from(await suffix.arrayBuffer())
  check(
    'a suffix range returns the END of the file',
    suffixBytes.equals(wholeBytes.subarray(fileSize - 500)),
    `${suffixBytes.length} bytes`,
  )

  const openEnded = await get(`/api/files/${file.id}/raw`, { range: `bytes=${fileSize - 10}-` })
  check(
    'an open-ended range runs to the end',
    Buffer.from(await openEnded.arrayBuffer()).equals(wholeBytes.subarray(fileSize - 10)),
  )

  const past = await get(`/api/files/${file.id}/raw`, { range: `bytes=${fileSize + 100}-` })
  check('an unsatisfiable range returns 416', past.status === 416, `HTTP ${past.status}`)
  check('416 reports the real size', past.headers.get('content-range') === `bytes */${fileSize}`)

  section('Inline mode for the viewer')
  const inline = await get(`/api/files/${file.id}/raw?inline=1`)
  check(
    'inline disposition',
    (inline.headers.get('content-disposition') ?? '').startsWith('inline'),
  )
  await inline.arrayBuffer()

  section('Authorisation')
  const anonymous = await fetch(`${BASE}/api/files/${file.id}/raw`, { redirect: 'manual' })
  check('anonymous download refused', anonymous.status === 403, `HTTP ${anonymous.status}`)

  const missing = await get('/api/files/00000000-0000-4000-8000-000000000000/raw')
  check('unknown file returns 404', missing.status === 404, `HTTP ${missing.status}`)

  section('Whole-model ZIP')
  const model = await db.execute<{
    id: string
    public_id: string
    name: string
    file_count: number
  }>(sql`
    SELECT id, public_id, name, file_count FROM models
    WHERE library_id = ${LIBRARY_ID} AND missing_at IS NULL AND file_count > 1
    ORDER BY file_count DESC LIMIT 1`)
  const target = model.rows[0]!
  check(
    'found a multi-file model',
    target.file_count > 1,
    `${target.name} (${target.file_count} files)`,
  )

  const secret = process.env.BETTER_AUTH_SECRET!
  const expires = Date.now() + 60_000
  const token = createHmac('sha256', secret).update(`${target.id}:${expires}`).digest('hex')

  const zipResponse = await get(
    `/api/download/model?model=${target.id}&expires=${expires}&token=${token}`,
  )
  check('zip endpoint returns 200', zipResponse.status === 200, `HTTP ${zipResponse.status}`)
  check('served as a zip', zipResponse.headers.get('content-type') === 'application/zip')
  check(
    'names the archive after the model',
    (zipResponse.headers.get('content-disposition') ?? '').includes('.zip'),
  )

  const zipBytes = new Uint8Array(await zipResponse.arrayBuffer())
  check('archive has content', zipBytes.byteLength > 0, `${zipBytes.byteLength} bytes`)

  const entries = unzipSync(zipBytes)
  const names = Object.keys(entries)
  check(
    'archive contains every file',
    names.length === target.file_count,
    `${names.length}/${target.file_count}: ${names.join(', ')}`,
  )
  check(
    'folder structure is preserved',
    names.some((n) => n.includes('/')),
    names.join(', '),
  )
  check(
    'entries have real content',
    Object.values(entries).every((d) => d.byteLength > 0),
  )

  // Compression is off on purpose: STL is dense float data and 3MF is already a
  // zip, so deflating spends CPU for almost nothing.
  const totalUncompressed = Object.values(entries).reduce((sum, d) => sum + d.byteLength, 0)
  check(
    'stored rather than deflated',
    zipBytes.byteLength >= totalUncompressed,
    `${zipBytes.byteLength} archive vs ${totalUncompressed} content`,
  )

  section('ZIP link security')
  const tampered = await get(
    `/api/download/model?model=${target.id}&expires=${expires + 60_000}&token=${token}`,
  )
  check('extending the expiry is rejected', tampered.status === 403, `HTTP ${tampered.status}`)

  const otherModel = await db.execute<{ id: string }>(sql`
    SELECT id FROM models WHERE library_id = ${LIBRARY_ID} AND id <> ${target.id} LIMIT 1`)
  const swapped = await get(
    `/api/download/model?model=${otherModel.rows[0]!.id}&expires=${expires}&token=${token}`,
  )
  check(
    'reusing a token for another model is rejected',
    swapped.status === 403,
    `HTTP ${swapped.status}`,
  )

  const expiredAt = Date.now() - 1000
  const expiredToken = createHmac('sha256', secret)
    .update(`${target.id}:${expiredAt}`)
    .digest('hex')
  const expired = await get(
    `/api/download/model?model=${target.id}&expires=${expiredAt}&token=${expiredToken}`,
  )
  check('an expired link is rejected', expired.status === 403, `HTTP ${expired.status}`)

  section('Model page offers the viewer')
  const html = (await (await get(`/models/${target.public_id}`)).text()).replace(/<!--.*?-->/g, '')
  check('page renders', html.includes(target.name))
  check('per-file download links present', html.includes(`/raw`))
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
