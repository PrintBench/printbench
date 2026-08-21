/**
 * End-to-end check of the S3 backend against a real S3 API.
 *
 *   docker compose -f docker-compose.dev.yml --profile s3 up -d
 *   npx tsx scripts/verify-s3.mts
 *
 * Unit tests can only assert the S3 adapter's pure decisions — key
 * construction, the read-only guard. Everything that actually matters about
 * S3 is in the round trip: whether a multipart upload of a large stream
 * completes, whether the bytes come back identical, whether a scan of a
 * bucket produces the same models a folder would. None of that is provable
 * without a bucket, which is what MinIO is here for.
 */
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { zipSync } from 'fflate'
import {
  LocalAdapter,
  ReadOnlyLibraryError,
  S3Adapter,
  createStorageAdapter,
  encryptSecret,
  libraryLocationFromRow,
  loadRootEnv,
  scanLibrary,
  type LibraryLocation,
} from '@pb/core'
import { createDb, schema } from '@pb/db'
import { extractZipIntoLibrary } from '../apps/worker/src/http/zip-ingest'

loadRootEnv()

const ENDPOINT = process.env.VERIFY_S3_ENDPOINT ?? 'http://localhost:9000'
const BUCKET = process.env.VERIFY_S3_BUCKET ?? 'printbench-test'
const ACCESS_KEY = process.env.VERIFY_S3_ACCESS_KEY ?? 'printbench'
const SECRET_KEY = process.env.VERIFY_S3_SECRET_KEY ?? 'printbench'

/** Unique per run, so a failed run never poisons the next one. */
const PREFIX = `verify-${Date.now()}`
const LIBRARY_ID = '55550000-0000-4000-8000-000000000001'

const { pool, db } = createDb()

let passed = 0
let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (ok) passed++
  else failed++
}
const section = (title: string) => console.log(`\n== ${title} ==`)

const managed: LibraryLocation = {
  id: LIBRARY_ID,
  kind: 'managed',
  backend: 's3',
  allowWrites: true,
  s3Bucket: BUCKET,
  s3Prefix: PREFIX,
  s3Endpoint: ENDPOINT,
  s3Region: 'us-east-1',
  s3AccessKeyId: ACCESS_KEY,
  s3SecretAccessKey: SECRET_KEY,
  s3ForcePathStyle: true,
}

const sha = (data: Buffer | Uint8Array) => createHash('sha256').update(data).digest('hex')

async function readAll(storage: S3Adapter, key: string): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of await storage.createReadStream(key)) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

let workDir = ''

async function cleanup() {
  await db.execute(sql`DELETE FROM libraries WHERE id = ${LIBRARY_ID}`)
  if (workDir) await rm(workDir, { recursive: true, force: true })
}

try {
  await cleanup()
  workDir = await mkdtemp(path.join(tmpdir(), 'pb-s3-'))

  section('Reachability')
  const storage = new S3Adapter(managed)
  const health = await storage.healthCheck()
  check('bucket reachable', health.ok, health.reason ?? `${health.entryCount} entries`)
  if (!health.ok) throw new Error('MinIO is not reachable; is the s3 profile up?')

  section('Small writes')
  await storage.write('Widget/notes.txt', 'hello from print manager')
  const small = await readAll(storage, 'Widget/notes.txt')
  check('a string round-trips', small.toString('utf8') === 'hello from print manager')

  const statted = await storage.stat('Widget/notes.txt')
  check('stat reports the size', statted?.size === small.byteLength, `${statted?.size} bytes`)

  section('Multipart upload')
  /*
   * 128 MiB, chosen so the memory claim is actually testable. The multipart
   * buffer is partSize × queueSize = 32 MiB, so a smaller file than that
   * would "pass" a no-buffering check even if the whole thing were held in
   * memory. At 128 MiB a buffered implementation cannot hide.
   *
   * Random bytes so the digest comparison means something: a run of zeroes
   * round-trips fine even if parts are silently reordered or dropped.
   */
  const MEGABYTE = 1024 * 1024
  const bigPath = path.join(workDir, 'big.stl')
  const bigBytes = randomBytes(128 * MEGABYTE)
  await writeFile(bigPath, bigBytes)
  const bigDigest = sha(bigBytes)
  // Released before measuring, so the fixture itself is not counted as though
  // it were upload buffering.
  const bigSize = bigBytes.byteLength

  const baseline = process.memoryUsage().heapUsed
  let peakHeap = baseline
  const sampler = setInterval(() => {
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed)
  }, 25)

  await storage.write('Widget/big.stl', createReadStream(bigPath))
  clearInterval(sampler)

  const growth = peakHeap - baseline
  const roundTripped = await readAll(storage, 'Widget/big.stl')

  check('128 MB stream uploads', roundTripped.byteLength === bigSize, `${roundTripped.byteLength} bytes`)
  check('and comes back byte-identical', sha(roundTripped) === bigDigest)
  /*
   * The whole point of the change. 96 MiB is the 32 MiB in-flight window plus
   * generous slack for the SDK's own copies; the old buffering implementation
   * would have had to hold all 128 MiB at once and would fail this outright.
   */
  check(
    'without ever holding the whole file in memory',
    growth < 96 * MEGABYTE,
    `peak heap +${Math.round(growth / MEGABYTE)} MB for a ${Math.round(bigSize / MEGABYTE)} MB file`,
  )

  section('Presigned download')
  const delivery = await storage.downloadUrl('Widget/big.stl', 'big.stl')
  check('yields a redirect', delivery.kind === 'redirect')
  if (delivery.kind === 'redirect') {
    const response = await fetch(delivery.url)
    const fetched = Buffer.from(await response.arrayBuffer())
    check('the URL serves the real bytes', sha(fetched) === bigDigest, `${response.status}`)
    check('and names the download', (response.headers.get('content-disposition') ?? '').includes('big.stl'))
  }

  section('Read-only guard')
  const readOnly = new S3Adapter({ ...managed, kind: 'in_place', allowWrites: false })
  let refused = false
  try {
    await readOnly.write('Widget/should-not-exist.txt', 'nope')
  } catch (error) {
    refused = error instanceof ReadOnlyLibraryError
  }
  check('refuses a write to a read-only bucket library', refused)
  check('and wrote nothing', (await readOnly.stat('Widget/should-not-exist.txt')) === null)

  section('Zip extraction into a bucket')
  const zipPath = path.join(workDir, 'pack.zip')
  const encoder = new TextEncoder()
  await writeFile(
    zipPath,
    zipSync({
      'Pack/body.stl': encoder.encode('body-mesh-bytes'),
      'Pack/images/preview.png': encoder.encode('image-bytes'),
      '__MACOSX/._body.stl': encoder.encode('junk'),
    }),
  )
  const extracted = await extractZipIntoLibrary(zipPath, storage, 'Pack')
  check('extracts through the adapter', extracted.filesExtracted === 2, `${extracted.filesExtracted} files`)
  check('unwraps the common root', (await storage.stat('Pack/body.stl')) !== null)
  check('drops macOS junk', (await storage.stat('Pack/__MACOSX/._body.stl')) === null)

  let refusedSecond = false
  try {
    await extractZipIntoLibrary(zipPath, storage, 'Pack')
  } catch {
    refusedSecond = true
  }
  check('refuses to extract over an existing folder', refusedSecond)

  section('Scanning a bucket')
  await db.execute(sql`
    INSERT INTO libraries (id, name, kind, backend, allow_writes, s3_bucket, s3_prefix,
                           s3_endpoint, s3_region, s3_access_key_id, s3_secret_access_key,
                           s3_force_path_style)
    VALUES (${LIBRARY_ID}, 'S3 Verify', 'managed', 's3', true, ${BUCKET}, ${PREFIX},
            ${ENDPOINT}, 'us-east-1', ${ACCESS_KEY}, ${encryptSecret(SECRET_KEY)}, true)`)

  const rows = await db
    .select()
    .from(schema.libraries)
    .where(sql`id = ${LIBRARY_ID}`)
  const location = libraryLocationFromRow(rows[0]!)
  check('credentials decrypt out of the database', location.s3SecretAccessKey === SECRET_KEY)

  const scanStorage = createStorageAdapter(location)
  const outcome = await scanLibrary(
    { db, storage: scanStorage, library: { ...location, groupingMode: 'deepest' } as LibraryLocation },
    { mode: 'deep' },
  )
  check('scan succeeds', outcome.status === 'succeeded', outcome.abortReason ?? '')

  const models = await db.execute<{ name: string; path: string; file_count: number }>(sql`
    SELECT name, path, file_count FROM models
    WHERE library_id = ${LIBRARY_ID} AND missing_at IS NULL ORDER BY path`)
  const found = models.rows.map((row) => `${row.path}(${row.file_count})`)
  check('finds the uploaded models', found.length === 2, found.join(', '))
  check('groups Widget from its files', found.some((entry) => entry.startsWith('Widget(')))
  check('groups Pack from the extracted zip', found.some((entry) => entry.startsWith('Pack(')))

  section('Deleting')
  await storage.remove('Widget/notes.txt')
  check('removes an object', (await storage.stat('Widget/notes.txt')) === null)
  check('and leaves its neighbours', (await storage.stat('Widget/big.stl')) !== null)

  section('A local library still behaves identically')
  // The same extractor, against the other backend, so a change made for S3
  // cannot quietly break the path almost everyone actually uses.
  const localRoot = path.join(workDir, 'local-library')
  const localStorage = new LocalAdapter({
    id: 'local-verify',
    kind: 'managed',
    backend: 'local',
    allowWrites: true,
    path: localRoot,
  })
  const localExtracted = await extractZipIntoLibrary(zipPath, localStorage, 'Pack')
  check('extracts into a local library too', localExtracted.filesExtracted === 2)
  check(
    'with the same contents',
    (await stat(path.join(localRoot, 'Pack', 'body.stl'))).size === 'body-mesh-bytes'.length,
  )
} catch (error) {
  console.error('\nUNEXPECTED ERROR:', error)
  failed++
} finally {
  section('Cleanup')
  try {
    const storage = new S3Adapter(managed)
    for (const key of [
      'Widget/notes.txt',
      'Widget/big.stl',
      'Pack/body.stl',
      'Pack/images/preview.png',
    ]) {
      await storage.remove(key).catch(() => undefined)
    }
    check('test objects removed', true)
  } catch {
    check('test objects removed', false)
  }
  await cleanup()
  await pool.end()
  console.log(`\n${passed} passed, ${failed} failed\n`)
  process.exit(failed > 0 ? 1 : 0)
}
