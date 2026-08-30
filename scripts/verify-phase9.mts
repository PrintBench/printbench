/**
 * End-to-end check of phase 9: the print queue.
 *
 *   npx tsx scripts/verify-phase9.mts
 *
 * Two things are worth proving here beyond "the rows insert". First, the
 * split in who may do what: anyone signed in can ask for a print, but only a
 * member can claim the printer, and the server has to enforce that rather than
 * relying on a hidden button. Second, the auto-link: it fills in a field
 * nobody re-checks, so it is asserted to link when it is certain and to keep
 * its hands off when it is not.
 */
import { sql } from 'drizzle-orm'
import {
  can,
  createRequest,
  createRequests,
  deletePrint,
  findExactModelMatch,
  getRequest,
  linkRequest,
  listPrints,
  listRequests,
  loadRootEnv,
  openRequestsForModel,
  parseRequestLines,
  printStats,
  queueStats,
  setRequestStatus,
  updatePrint,
} from '@pb/core'
import { createDb } from '@pb/db'

loadRootEnv()

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000'
const JSON_HEADERS = { 'content-type': 'application/json', origin: BASE }
const EMAIL = 'phase9-verify@example.test'
const PASSWORD = 'verify-only-throwaway-passphrase'
const LIBRARY_ID = '99999999-9999-4999-8999-999999999999'
const DRAGON = '99999999-9999-4999-8999-99999999000a'
const CLIP = '99999999-9999-4999-8999-99999999000b'

const { pool, db } = createDb()

let passed = 0
let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (ok) passed++
  else failed++
}
const section = (title: string) => console.log(`\n== ${title} ==`)

async function get(path: string, cookie?: string) {
  return fetch(`${BASE}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} })
}

async function cleanup() {
  await db.execute(sql`DELETE FROM print_requests`)
  await db.execute(sql`DELETE FROM models WHERE library_id = ${LIBRARY_ID}`)
  await db.execute(sql`DELETE FROM libraries WHERE id = ${LIBRARY_ID}`)
  await db.execute(sql`DELETE FROM "user" WHERE email = ${EMAIL}`)
}

try {
  await cleanup()

  section('Signed out')
  const anonymous = await get('/queue')
  check(
    '/queue is not reachable without a session',
    (anonymous.headers.get('location') ?? '').includes('/login') || anonymous.status === 307,
    `HTTP ${anonymous.status}`,
  )

  section('Fixtures')
  await db.execute(sql`
    INSERT INTO libraries (id, name, kind, backend, path)
    VALUES (${LIBRARY_ID}, 'Phase 9 Fixture', 'in_place', 'local', '/fixtures/phase9')`)

  for (const [id, suffix, name] of [
    [DRAGON, 'a', 'Phase Nine Dragon'],
    [CLIP, 'b', 'Phase Nine Clip'],
  ] as const) {
    await db.execute(sql`
      INSERT INTO models (id, library_id, path, name, slug, public_id, file_count, total_size)
      VALUES (${id}, ${LIBRARY_ID}, ${'p9/' + suffix}, ${name}, ${'p9-' + suffix},
              ${'md900000000' + suffix}, 1, 1000)`)
  }
  check('two models indexed', true)

  const signUp = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name: 'Phase Nine Verify', email: EMAIL, password: PASSWORD }),
  })
  check('throwaway account created', signUp.ok, `HTTP ${signUp.status}`)

  const created = await db.execute<{ id: string }>(
    sql`SELECT id FROM "user" WHERE email = ${EMAIL}`,
  )
  const userId = created.rows[0]!.id

  const signIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  const cookie = (signIn.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
  check('session cookie issued', cookie.length > 0)

  section('Who may do what')
  const viewer = { id: userId, role: 'viewer' }
  const member = { id: userId, role: 'member' }
  check('a viewer may ask for a print', can(viewer, 'request:create'))
  check('a viewer may NOT claim the printer', !can(viewer, 'request:manage'))
  check('a member may work the queue', can(member, 'request:manage'))

  section('Adding a batch, the way a message arrives')
  const message = ['Phase Nine Dragon', 'Phase nine clip x4', '- Something for the kitchen roll']
  const lines = parseRequestLines(message.join('\n'))
  check('one request per line', lines.length === 3, `${lines.length}`)
  check(
    'the count is read off the line',
    lines[1]?.quantity === 4 && lines[1]?.title === 'Phase nine clip',
    `${lines[1]?.title} x${lines[1]?.quantity}`,
  )
  check('pasted list punctuation is stripped', lines[2]?.title.startsWith('Something'))

  const batch = await createRequests(
    db,
    lines.map((line) => ({ ...line, requestedBy: 'Nan' })),
    userId,
  )
  check('all three land in the queue', batch.created === 3, `${batch.created}`)
  check('the two that name a model are linked to it', batch.autoLinked === 2, `${batch.autoLinked}`)

  section('The auto-link knows what it does not know')
  check('an exact name resolves', (await findExactModelMatch(db, 'phase nine dragon')) === DRAGON)
  check('a partial name does not', (await findExactModelMatch(db, 'Dragon')) === null)
  check('nonsense does not', (await findExactModelMatch(db, 'zzz nothing')) === null)

  section('A request needs no file')
  const orphan = (await listRequests(db)).find((r) => r.title.startsWith('Something'))
  check('the unmatched request still exists', orphan != null)
  check('and is honestly marked as unlinked', orphan?.modelId === null)

  section('Linking one by hand, later')
  await linkRequest(db, orphan!.id, CLIP)
  check('it now points at a model', (await getRequest(db, orphan!.id))?.modelId === CLIP)
  await linkRequest(db, orphan!.id, null)
  check('and can be unlinked again', (await getRequest(db, orphan!.id))?.modelId === null)

  section('The queue page')
  const queuePage = await get('/queue', cookie)
  const queueHtml = await queuePage.text()
  check('renders', queuePage.status === 200, `HTTP ${queuePage.status}`)
  check('lists what was asked for', queueHtml.includes('Phase Nine Dragon'))
  check('shows who asked', queueHtml.includes('Nan'))
  check('shows the count on a multiple', queueHtml.includes('4'))
  check('says when something has no file yet', queueHtml.includes('Not in the library yet'))

  section('A viewer is not offered the printer controls')
  check('no start button for a viewer', !queueHtml.includes('>Start<'))

  section('Working through it')
  const dragonRequest = (await listRequests(db)).find((r) => r.modelId === DRAGON)!
  await setRequestStatus(db, dragonRequest.id, 'printing')
  check(
    'a request can go on the printer',
    (await getRequest(db, dragonRequest.id))?.status === 'printing',
  )

  const printingOnly = await listRequests(db, { status: ['printing'] })
  check('the filter narrows to it', printingOnly.length === 1, `${printingOnly.length}`)

  await setRequestStatus(db, dragonRequest.id, 'done')
  const finished = await getRequest(db, dragonRequest.id)
  check('finishing stamps a closing time', finished?.closedAt != null)
  await setRequestStatus(db, dragonRequest.id, 'requested')
  check(
    'reopening clears it, so no row is both open and closed',
    (await getRequest(db, dragonRequest.id))?.closedAt == null,
  )

  section('Counts')
  const stats = await queueStats(db)
  check('waiting is counted', stats.waiting === 3, `${stats.waiting}`)
  check('nothing is falsely overdue', stats.overdue === 0, `${stats.overdue}`)

  section('Marking printed reaches the print history')
  const toPrint = await createRequest(
    db,
    { title: 'Phase Nine Clip', modelId: CLIP, requestedBy: 'Nan', quantity: 3, material: 'PETG' },
    userId,
  )
  await setRequestStatus(db, toPrint.id, 'done', { userId })

  const logged = await listPrints(db, { modelId: CLIP })
  check('the print is logged against the model', logged.length === 1, `${logged.length}`)
  check('with the material the request asked for', logged[0]?.material === 'PETG')
  check('and a note explaining where it came from', logged[0]?.notes?.includes('queue') === true)
  check('the model no longer reads as never printed', (await printStats(db, CLIP)).total === 1)
  check(
    'the request remembers its history entry',
    (await getRequest(db, toPrint.id))?.printRunId != null,
  )

  const historyHtml = await (await get('/prints', cookie)).text()
  check('and it shows on the print history page', historyHtml.includes('Phase Nine Clip'))

  section('Reopening withdraws it again')
  await setRequestStatus(db, toPrint.id, 'requested', { userId })
  check('the entry is gone', (await listPrints(db, { modelId: CLIP })).length === 0)
  check('and the link is cleared', (await getRequest(db, toPrint.id))?.printRunId == null)

  section('But not once somebody has filled it in')
  await setRequestStatus(db, toPrint.id, 'done', { userId })
  const adopted = (await getRequest(db, toPrint.id))!.printRunId!
  await updatePrint(db, adopted, { rating: 5, filamentUsedG: 42 })
  await setRequestStatus(db, toPrint.id, 'requested', { userId })
  const kept = await listPrints(db, { modelId: CLIP })
  check('a rated print survives the reopen', kept.length === 1, `${kept.length}`)
  check('with the rating intact', kept[0]?.rating === 5)

  section('An unlinked request logs nothing')
  const unlinked = await createRequest(db, { title: 'No model for this' }, userId)
  await setRequestStatus(db, unlinked.id, 'done', { userId })
  check('no history entry was invented', (await getRequest(db, unlinked.id))?.printRunId == null)

  section('Deleting the print by hand does not orphan the request')
  await deletePrint(db, kept[0]!.id)
  const orphaned = await getRequest(db, toPrint.id)
  check('the request survives', orphaned != null)
  check('with its history link cleared', orphaned?.printRunId == null)

  section('The model page knows it is wanted')
  const openForDragon = await openRequestsForModel(db, DRAGON)
  check('open requests are found by model', openForDragon.length === 1, `${openForDragon.length}`)

  const modelHtml = await (await get('/models/md900000000a', cookie)).text()
  check('the model page offers the queue button', modelHtml.includes('Queue'))

  section('The dashboard surfaces the backlog')
  const dashHtml = await (await get('/', cookie)).text()
  check('"Waiting to print" appears', dashHtml.includes('Waiting to print'))
  check('with the actual request in it', dashHtml.includes('Phase Nine Dragon'))

  section('Promotion takes effect on the same session')
  await db.execute(sql`UPDATE "user" SET role = 'member' WHERE email = ${EMAIL}`)
  const asMember = await (await get('/queue', cookie)).text()
  check('a member IS offered the printer controls', asMember.includes('Start'))

  section('A model that goes missing does not take the request with it')
  await db.execute(sql`UPDATE models SET missing_at = now() WHERE id = ${DRAGON}`)
  const stillThere = await getRequest(db, dragonRequest.id)
  check('the request survives', stillThere != null)
  check('and says the model is gone', stillThere?.modelMissing === true)
  await db.execute(sql`UPDATE models SET missing_at = NULL WHERE id = ${DRAGON}`)

  section('Deleting the model clears the link but keeps the request')
  const survivor = await createRequest(db, { title: 'Outlives its model', modelId: CLIP }, userId)
  await db.execute(sql`DELETE FROM models WHERE id = ${CLIP}`)
  const after = await getRequest(db, survivor.id)
  check('the request is still queued', after != null)
  check('with the link cleared rather than cascaded away', after?.modelId === null)
} catch (error) {
  console.error('\nUNEXPECTED ERROR:', error)
  failed++
} finally {
  section('Cleanup')
  await cleanup()
  const left = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM print_requests`)
  check('throwaway data removed', (left.rows[0]?.n ?? -1) === 0)
  await pool.end()
  console.log(`\n${passed} passed, ${failed} failed\n`)
  process.exit(failed > 0 ? 1 : 0)
}
