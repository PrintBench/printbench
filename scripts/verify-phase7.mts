/**
 * End-to-end check of phase 7: print history, open-in-slicer, send-to-printer.
 *
 *   npx tsx scripts/verify-phase7.mts
 *
 * The printer is a stub HTTP server started here, so the send path is exercised
 * for real — the request shape, the decrypted API key and the start flag are all
 * asserted against what actually arrived — without needing hardware.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import {
  LocalAdapter,
  canSendToPrinter,
  decryptSecret,
  encryptSecret,
  loadRootEnv,
  probeHost,
  scanLibrary,
  sendToPrinter,
  signToken,
  slicerUrl,
  slicersFor,
  type LibraryLocation,
} from '@pm/core'
import { createDb } from '@pm/db'

loadRootEnv()

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000'
const JSON_HEADERS = { 'content-type': 'application/json', origin: BASE }
const EMAIL = 'phase7-verify@example.test'
const PASSWORD = 'verify-only-throwaway-passphrase'
const LIBRARY_ID = '77777777-7777-4777-8777-777777777777'
const HOST_ID = '77777777-7777-4777-8777-888888888888'
const STUB_PORT = 18_899
const API_KEY = 'verify-api-key-1234567890'

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
let stub: Server | null = null

/** Everything the stub printer saw, so the request shape can be asserted. */
const received: {
  method: string
  url: string
  apiKey: string | null
  contentType: string
  body: Buffer
}[] = []

function startStubPrinter(): Promise<void> {
  return new Promise((resolve) => {
    stub = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(chunk as Buffer))
      req.on('end', () => {
        received.push({
          method: req.method ?? '',
          url: req.url ?? '',
          apiKey: (req.headers['x-api-key'] as string) ?? null,
          contentType: (req.headers['content-type'] as string) ?? '',
          body: Buffer.concat(chunks),
        })

        if (req.url === '/api/version') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ server: '1.10.3', text: 'OctoPrint 1.10.3' }))
          return
        }
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ files: { local: { path: 'cube.gcode' } } }))
      })
    })
    stub.listen(STUB_PORT, () => resolve())
  })
}

/** An ephemeral port with nothing listening on it. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })
}

async function cleanup() {
  await db.execute(sql`DELETE FROM print_runs WHERE model_id IN
    (SELECT id FROM models WHERE library_id = ${LIBRARY_ID})`)
  await db.execute(sql`DELETE FROM print_hosts WHERE id = ${HOST_ID}`)
  await db.execute(sql`DELETE FROM libraries WHERE id = ${LIBRARY_ID}`)
  await db.execute(sql`DELETE FROM "user" WHERE email = ${EMAIL}`)
  if (libraryRoot) await rm(path.dirname(libraryRoot), { recursive: true, force: true })
}

try {
  await cleanup()

  section('Set up')
  const base = await mkdtemp(path.join(tmpdir(), 'pm-p7-'))
  libraryRoot = path.join(base, 'library')
  await mkdir(path.join(libraryRoot, 'Calibration Cube'), { recursive: true })

  // A mesh a slicer would open, and a sliced file a printer would accept.
  await writeFile(
    path.join(libraryRoot, 'Calibration Cube', 'cube.stl'),
    Buffer.concat([Buffer.alloc(80), Buffer.alloc(4)]),
  )
  await writeFile(
    path.join(libraryRoot, 'Calibration Cube', 'cube.gcode'),
    'M73 P0 R42\nG28\nG1 Z0.2 F600\nG1 X10 Y10 E1 F1200\n',
  )

  await db.execute(sql`
    INSERT INTO libraries (id, name, kind, backend, path)
    VALUES (${LIBRARY_ID}, 'Phase Seven Verify', 'in_place', 'local', ${libraryRoot})
  `)

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

  const files = await db.execute<{ id: string; filename: string; extension: string }>(sql`
    SELECT f.id, f.filename, f.extension FROM model_files f
    JOIN models m ON m.id = f.model_id WHERE m.library_id = ${LIBRARY_ID}
  `)
  const stl = files.rows.find((row) => row.extension === 'stl')
  const gcode = files.rows.find((row) => row.extension === 'gcode')
  check('mesh and sliced file both indexed', Boolean(stl && gcode))

  const model = await db.execute<{ id: string; public_id: string }>(sql`
    SELECT id, public_id FROM models WHERE library_id = ${LIBRARY_ID} LIMIT 1
  `)
  const modelId = model.rows[0]!.id

  await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name: 'Phase Seven Verify', email: EMAIL, password: PASSWORD }),
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

  section('Print history')
  const userRow = await db.execute<{ id: string }>(
    sql`SELECT id FROM "user" WHERE email = ${EMAIL}`,
  )
  const { logPrint, listPrints, printStats, printBelongsToModel } = await import('@pm/core')

  await logPrint(db, {
    modelId,
    modelFileId: gcode!.id,
    userId: userRow.rows[0]!.id,
    printerName: 'Verify P1S',
    material: 'PLA',
    layerHeightMm: 0.2,
    status: 'success',
    startedAt: new Date('2026-08-01T09:00:00Z'),
    finishedAt: new Date('2026-08-01T12:30:00Z'),
    filamentUsedG: 48.5,
    rating: 5,
    notes: 'Verification print.',
  })
  const running = await logPrint(db, { modelId, status: 'in_progress' })

  const runs = await listPrints(db, { modelId })
  check('both prints recorded', runs.length === 2, `${runs.length}`)
  check('duration derived from timestamps', runs.some((r) => r.durationMin === 210))
  check('model joined for linking', runs[0]?.modelName === 'Calibration Cube')

  const stats = await printStats(db, modelId)
  check('success rate ignores the running print', stats.successRate === 1, `${stats.successRate}`)
  check('filament totalled', stats.totalFilamentG === 48.5)

  const otherModel = await db.execute<{ id: string }>(
    sql`SELECT id FROM models WHERE library_id <> ${LIBRARY_ID} LIMIT 1`,
  )
  if (otherModel.rows[0]) {
    check(
      'a print cannot be claimed by another model',
      !(await printBelongsToModel(db, running.id, otherModel.rows[0].id)),
    )
  }

  const failedOnly = await listPrints(db, { modelId, status: ['failed'] })
  check('outcome filter narrows', failedOnly.length === 0)

  section('Pages render')
  const printsPage = await text('/prints')
  check('print history page lists the print', printsPage.includes('Calibration Cube'))
  check('print history page summarises', printsPage.includes('print'))

  const modelPage = await text(`/models/${model.rows[0]!.public_id}`)
  check('model page shows the history', modelPage.includes('Print history'))
  check('model page offers a slicer', modelPage.includes('Open in'))

  section('Open in slicer')
  const forStl = slicersFor('stl')
  check('every slicer offered for a mesh', forStl.length === 5, `${forStl.length}`)
  check('no slicer offered for gcode', slicersFor('gcode').length === 0)

  const secret = process.env.BETTER_AUTH_SECRET!
  const { token, expires } = signToken(secret, 'file', stl!.id, 15 * 60 * 1000)
  const fileUrl = `${BASE}/api/files/${stl!.id}/raw?token=${token}&expires=${expires}`
  const link = slicerUrl(forStl[0]!, fileUrl)
  check('handoff link is a slicer scheme', link.startsWith('bambustudio://open?file='))
  check('file URL is encoded into it', link.includes('%3Ftoken%3D'))

  // The decisive test: a slicer has no cookie, so the signature must carry it.
  const withToken = await fetch(fileUrl)
  check('signed link serves the file without a session', withToken.status === 200)

  const tampered = await fetch(fileUrl.replace(token, token.replace(/^./, 'f')))
  check('a tampered signature is refused', tampered.status === 403, `${tampered.status}`)

  const noToken = await fetch(`${BASE}/api/files/${stl!.id}/raw`)
  check('no signature and no session is refused', noToken.status === 403)

  const wrongFile = await fetch(
    `${BASE}/api/files/${gcode!.id}/raw?token=${token}&expires=${expires}`,
  )
  check('a signature for another file is refused', wrongFile.status === 403)

  section('Send to printer')
  await startStubPrinter()
  const endpoint = `http://127.0.0.1:${STUB_PORT}`

  await db.execute(sql`
    INSERT INTO print_hosts (id, name, protocol, endpoint, credentials)
    VALUES (${HOST_ID}, 'Verify OctoPi', 'octoprint', ${endpoint}, ${encryptSecret(API_KEY)})
  `)

  const stored = await db.execute<{ credentials: string }>(
    sql`SELECT credentials FROM print_hosts WHERE id = ${HOST_ID}`,
  )
  check('API key encrypted at rest', !stored.rows[0]!.credentials.includes(API_KEY))
  check('and decrypts back', decryptSecret(stored.rows[0]!.credentials) === API_KEY)

  const host = {
    id: HOST_ID,
    name: 'Verify OctoPi',
    protocol: 'octoprint' as const,
    endpoint,
    apiKey: decryptSecret(stored.rows[0]!.credentials),
  }

  const status = await probeHost(host)
  check('printer probe succeeds', status.ok, status.error ?? status.version ?? '')

  check('gcode is sendable', canSendToPrinter('gcode'))
  check('a mesh is not', !canSendToPrinter('stl'))

  const gcodeBytes = new TextEncoder().encode('M73 P0 R42\nG28\nG1 Z0.2 F600\n')
  const sent = await sendToPrinter(
    host,
    { filename: 'cube.gcode', data: gcodeBytes },
    { startPrint: true },
  )
  check('send reports success', sent.ok, sent.error ?? '')

  const upload = received.find((entry) => entry.url === '/api/files/local')
  check('posted to the OctoPrint upload endpoint', Boolean(upload))
  check('carried the decrypted API key', upload?.apiKey === API_KEY)
  check(
    'sent multipart with a boundary',
    (upload?.contentType ?? '').includes('multipart/form-data; boundary='),
  )
  const bodyText = upload?.body.toString('latin1') ?? ''
  check('the filename survived', bodyText.includes('cube.gcode'))
  check('the gcode arrived', bodyText.includes('G28'))
  check('asked the printer to start', /name="print"\r\n\r\ntrue/.test(bodyText))

  const rejected = await sendToPrinter(host, {
    filename: 'cube.stl',
    data: new Uint8Array(new ArrayBuffer(4)),
  })
  check('refuses to send an unsliced mesh', !rejected.ok && /sliced/i.test(rejected.error ?? ''))

  const badEndpoint = await sendToPrinter(
    { ...host, endpoint: 'file:///etc/passwd' },
    { filename: 'cube.gcode', data: gcodeBytes },
  )
  check('refuses a non-http endpoint', !badEndpoint.ok)

  /*
   * A port that genuinely refuses: bound, then released, so nothing is
   * listening on it. A hardcoded low port will not do — undici blocks several
   * of them outright, which is a different failure with a different message.
   */
  const deadPort = await freePort()
  const offline = await probeHost({ ...host, endpoint: `http://127.0.0.1:${deadPort}` })
  check(
    'an unreachable printer explains itself',
    !offline.ok && /refused/i.test(offline.error ?? ''),
    offline.error ?? '',
  )

  const badHost = await probeHost({ ...host, endpoint: 'http://printer.invalid' })
  check(
    'an unknown hostname explains itself',
    !badHost.ok && /resolve/i.test(badHost.error ?? ''),
    badHost.error ?? '',
  )

  // Whatever else goes wrong, the message must name the endpoint rather than
  // saying "fetch failed".
  const blocked = await probeHost({ ...host, endpoint: 'http://127.0.0.1:9' })
  check(
    'any other failure still names the endpoint',
    !blocked.ok && (blocked.error ?? '').includes('127.0.0.1:9'),
    blocked.error ?? '',
  )
} catch (error) {
  console.error('\nUNEXPECTED ERROR:', error)
  failed++
} finally {
  section('Cleanup')
  if (stub) await new Promise<void>((resolve) => stub!.close(() => resolve()))
  await cleanup()
  check('throwaway data removed', true)
  await pool.end()
  console.log(`\n${passed} passed, ${failed} failed\n`)
  process.exit(failed > 0 ? 1 : 0)
}
