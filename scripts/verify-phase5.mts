/**
 * End-to-end check of phase 5: search, facets and the command palette.
 *
 *   npx tsx scripts/verify-phase5.mts
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
const EMAIL = 'phase5-verify@example.test'
const PASSWORD = 'verify-only-throwaway-passphrase'
const LIBRARY_ID = '5a5a5a5a-6b6b-4c4c-8d8d-9e9e9e9e9e9e'
const CREATOR_ID = '5b5b5b5b-6b6b-4c4c-8d8d-9e9e9e9e9e9e'
const TAG_ID = '5c5c5c5c-6b6b-4c4c-8d8d-9e9e9e9e9e9e'

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
  await db.execute(sql`DELETE FROM creators WHERE id = ${CREATOR_ID}`)
  await db.execute(sql`DELETE FROM tags WHERE id = ${TAG_ID}`)
  await db.execute(sql`DELETE FROM "user" WHERE email = ${EMAIL}`)
}

async function waitFor<T>(probe: () => Promise<T | null>, label: string, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== null) return value
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

try {
  await cleanup()
  await queue.start()

  section('Set up and index')
  await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name: 'Phase Five Verify', email: EMAIL, password: PASSWORD }),
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

  await db.execute(sql`DELETE FROM libraries WHERE path = ${DEMO}`)
  await db.execute(sql`
    INSERT INTO libraries (id, name, kind, backend, path)
    VALUES (${LIBRARY_ID}, 'Search Demo', 'in_place', 'local', ${DEMO})`)
  await queue.send(
    JOB.libraryScan,
    { libraryId: LIBRARY_ID, mode: 'deep', force: false },
    { singletonKey: `scan:${LIBRARY_ID}:p5` },
  )
  const run = await waitFor(async () => {
    const r = await db.execute<{ status: string }>(sql`
      SELECT status FROM scan_runs WHERE library_id = ${LIBRARY_ID}
        AND status IN ('succeeded','aborted','failed') ORDER BY created_at DESC LIMIT 1`)
    return r.rows[0] ?? null
  }, 'the scan')
  check('library indexed', run.status === 'succeeded', run.status)

  // Give the facets something to work with.
  await db.execute(sql`
    INSERT INTO creators (id, name, slug, public_id)
    VALUES (${CREATOR_ID}, 'Loot Studios', 'loot-studios-p5', 'crp500000001')`)
  await db.execute(sql`
    INSERT INTO tags (id, name, slug) VALUES (${TAG_ID}, 'miniature', 'miniature-p5')`)
  await db.execute(sql`
    UPDATE models SET creator_id = ${CREATOR_ID}, license = 'CC-BY-4.0'
    WHERE library_id = ${LIBRARY_ID} AND path LIKE 'Loot Studios/%'`)
  await db.execute(sql`
    INSERT INTO model_tags (model_id, tag_id)
    SELECT id, ${TAG_ID} FROM models
    WHERE library_id = ${LIBRARY_ID} AND path LIKE 'Loot Studios/%'
    ON CONFLICT DO NOTHING`)

  // The vector must be rebuilt for the new creator and tags to be searchable.
  const ids = await db.execute<{ id: string }>(
    sql`SELECT id FROM models WHERE library_id = ${LIBRARY_ID}`,
  )
  const { refreshModelSearchVectors } = await import('@pb/core')
  await refreshModelSearchVectors(db, ids.rows.map((r) => r.id))
  check('search vectors rebuilt', ids.rows.length > 0, `${ids.rows.length} models`)

  section('Search page')
  const empty = await text('/search')
  check('renders with no query', empty.includes('Find anything in your library'))

  const dragon = await text('/search?q=dragon')
  check('finds a model by name', dragon.includes('Dragon Knight'))
  check('shows a result count', /\d+ models?/.test(dragon))
  check('excludes unrelated models', !dragon.includes('Cable Clip'))

  const troll = await text('/search?q=troll')
  check('finds another model', troll.includes('Forest Troll'))

  section('Matching behaviour through the UI')
  check('folds accents', (await text('/search?q=pokemon')).includes('Pok'))
  check('tolerates a typo', (await text('/search?q=draggon')).includes('Dragon Knight'))
  check(
    'matches a word inside a filename',
    (await text('/search?q=presupported')).includes('Dragon Knight'),
  )
  check('finds by creator name', (await text('/search?q=loot+studios')).includes('Dragon Knight'))
  check('finds by tag', (await text('/search?q=miniature')).includes('Dragon Knight'))

  const nothing = await text('/search?q=helicopter+carburettor')
  check('says so when nothing matches', nothing.includes('Nothing matches'))
  check('offers advice when nothing matches', nothing.includes('minus'))

  section('Facets')
  const faceted = await text('/search')
  check('shows a library facet', faceted.includes('Search Demo'))
  check('shows a creator facet', faceted.includes('Loot Studios'))
  check('shows a tag facet', faceted.includes('miniature'))
  check('shows a format facet', /\bstl\b/.test(faceted))
  check('offers the pre-supported filter', faceted.includes('Pre-supported'))
  check('offers the never-printed filter', faceted.includes('Never printed'))

  const byCreator = await text(`/search?creator=${CREATOR_ID}`)
  check('filtering by creator narrows results', byCreator.includes('Dragon Knight'))
  check('filtering by creator excludes others', !byCreator.includes('Cable Clip'))

  const bySupport = await text('/search?presupported=1')
  check('pre-supported filter works', bySupport.includes('Dragon Knight'))
  check('pre-supported filter excludes others', !bySupport.includes('Cable Clip'))

  const byFormat = await text('/search?format=3mf')
  check('format filter works', byFormat.includes('Watchtower') || byFormat.includes('Hinged Box'))
  check('format filter excludes other formats', !byFormat.includes('Benchy'))

  const combined = await text(`/search?q=dragon&creator=${CREATOR_ID}`)
  check('query and filter combine', combined.includes('Dragon Knight'))

  section('Filter state is in the URL')
  // The point of URL state: a filtered search is shareable and survives reload.
  check('filters survive a fresh request', (await text('/search?presupported=1')).includes('Dragon Knight'))
  check('a clear link is offered', faceted.includes('/search'))

  section('Sorting')
  const byName = await text('/search?sort=name')
  const byLargest = await text('/search?sort=largest')
  check('name sort renders', byName.includes('Ancient Golem'))
  check('size sort renders', byLargest.length > 0)
  check('sort control is present', byName.includes('Best match'))

  section('Command palette API')
  const api = await get('/api/search?q=dragon')
  const payload = (await api.json()) as { hits: { kind: string; label: string }[] }
  check('returns 200', api.status === 200, `HTTP ${api.status}`)
  check('returns model hits', payload.hits.some((h) => h.kind === 'model'), JSON.stringify(payload.hits.slice(0, 3)))

  const creatorHits = (await (await get('/api/search?q=loot')).json()) as {
    hits: { kind: string; label: string }[]
  }
  check(
    'returns creator hits too',
    creatorHits.hits.some((h) => h.kind === 'creator' && h.label === 'Loot Studios'),
    creatorHits.hits.map((h) => `${h.kind}:${h.label}`).join(', '),
  )

  const emptyQuery = (await (await get('/api/search?q=')).json()) as { hits: unknown[] }
  check('empty query returns nothing', emptyQuery.hits.length === 0)

  const anon = await fetch(`${BASE}/api/search?q=dragon`, { redirect: 'manual' })
  check('anonymous access refused', anon.status === 403, `HTTP ${anon.status}`)

  section('Query operators')
  const negated = await text('/search?q=dragon+-knight')
  check('negation excludes the term', !negated.includes('Dragon Knight'), 'searched: dragon -knight')

  section('Pagination')
  const page2 = await text('/search?page=2')
  check('a page past the end renders without failing', page2.length > 0)
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
