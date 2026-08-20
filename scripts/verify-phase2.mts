/**
 * End-to-end check of the phase 2 scanning surface.
 *
 * Builds a realistic library on disk, runs the real scan pipeline, and asserts
 * the results — including the safety guards, which are the whole reason this
 * script exists. Cleans up after itself.
 *
 *   npx tsx scripts/verify-phase2.mts
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { LocalAdapter, loadRootEnv, scanLibrary, type LibraryLocation } from '@pm/core'
import { createDb } from '@pm/db'

loadRootEnv()

const LIBRARY_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
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

let root = ''

/** A library shaped like a real collection, with all the usual awkwardness. */
async function buildLibrary(): Promise<void> {
  const make = async (dir: string, files: Record<string, string>) => {
    await mkdir(path.join(root, dir), { recursive: true })
    for (const [name, content] of Object.entries(files)) {
      await writeFile(path.join(root, dir, name), content)
    }
  }

  // A pack from a subscription: container -> models, with common subfolders.
  await make('Loot Studios/Dragon Knight/stl', { 'body.stl': 'x'.repeat(2048) })
  await make('Loot Studios/Dragon Knight/presupported', { 'body_sup.stl': 'x'.repeat(4096) })
  await make('Loot Studios/Dragon Knight/images', { 'preview.png': 'img' })
  await make('Loot Studios/Dragon Knight', { 'readme.txt': 'A knight' })
  await make('Loot Studios/Forest Troll', { 'troll.stl': 'y'.repeat(8192) })

  // Terrain with unicode and awkward names.
  await make('Terrain/Pokémon Gym 🏟', { 'gym.3mf': 'z'.repeat(1024) })
  await make("Terrain/Bob's Bridge & Tower", { 'bridge.stl': 'b'.repeat(512) })

  // Functional prints, plus rubbish that must be ignored.
  await make('Functional/Hinged Box', {
    'box.3mf': 'q'.repeat(256),
    'Thumbs.db': 'junk',
    '.DS_Store': 'junk',
  })
  await make('Functional/Hinged Box/__MACOSX', { '._box.3mf': 'junk' })

  // Loose files at the root.
  await writeFile(path.join(root, 'benchy.stl'), 'w'.repeat(128))
  await writeFile(path.join(root, 'calibration-cube.stl'), 'c'.repeat(64))
  await writeFile(path.join(root, 'notes.txt'), 'not a model')
}

const library = (): LibraryLocation => ({
  id: LIBRARY_ID,
  kind: 'in_place',
  backend: 'local',
  allowWrites: false,
  path: root,
})

const runScan = (options = {}) =>
  scanLibrary({ db, storage: new LocalAdapter(library()), library: library() }, { mode: 'deep', ...options })

async function models(): Promise<{ path: string; name: string; files: number }[]> {
  const result = await db.execute<{ path: string; name: string; file_count: number }>(sql`
    SELECT path, name, file_count FROM models
    WHERE library_id = ${LIBRARY_ID} AND missing_at IS NULL ORDER BY path
  `)
  return result.rows.map((r) => ({ path: r.path, name: r.name, files: r.file_count }))
}

async function missingCount(): Promise<number> {
  const result = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM models WHERE library_id = ${LIBRARY_ID} AND missing_at IS NOT NULL`,
  )
  return result.rows[0]?.n ?? 0
}

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM libraries WHERE id = ${LIBRARY_ID}`)
  if (root) await rm(path.dirname(root), { recursive: true, force: true })
}

try {
  const base = await mkdtemp(path.join(tmpdir(), 'pm-verify2-'))
  root = path.join(base, 'prints')
  await buildLibrary()

  await db.execute(sql`DELETE FROM libraries WHERE id = ${LIBRARY_ID}`)
  await db.execute(sql`
    INSERT INTO libraries (id, name, kind, backend, path)
    VALUES (${LIBRARY_ID}, 'Verify Phase 2', 'in_place', 'local', ${root})
  `)

  section('First scan of a realistic library')
  const first = await runScan()
  check('scan succeeds', first.status === 'succeeded', first.abortReason ?? '')

  const found = await models()
  const paths = found.map((m) => m.path)
  check('finds 7 models', found.length === 7, `found ${found.length}`)
  check('pack folders become containers, not models', !paths.includes('Loot Studios'))
  check('models inside a pack are indexed', paths.includes('Loot Studios/Dragon Knight'))
  check('common subfolders are absorbed into one model',
    found.find((m) => m.path === 'Loot Studios/Dragon Knight')?.files === 4,
    `${found.find((m) => m.path === 'Loot Studios/Dragon Knight')?.files} files`)
  check('unicode and emoji folder names survive', paths.includes('Terrain/Pokémon Gym 🏟'))
  check('apostrophes and ampersands survive', paths.includes("Terrain/Bob's Bridge & Tower"))
  check('loose root files each become a model', paths.includes('benchy.stl'))
  check('non-model loose files are ignored', !paths.includes('notes.txt'))

  const junk = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM model_files f JOIN models m ON m.id = f.model_id
    WHERE m.library_id = ${LIBRARY_ID}
      AND (f.filename ILIKE '%Thumbs.db%' OR f.filename ILIKE '%.DS_Store%'
           OR f.filename ILIKE '%__MACOSX%')
  `)
  check('OS junk files are never indexed', (junk.rows[0]?.n ?? -1) === 0)

  const supported = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM model_files f JOIN models m ON m.id = f.model_id
    WHERE m.library_id = ${LIBRARY_ID} AND f.presupported = true
  `)
  check('pre-supported files are flagged', (supported.rows[0]?.n ?? 0) >= 1)

  const preview = await db.execute<{ filename: string }>(sql`
    SELECT f.filename FROM models m JOIN model_files f ON f.id = m.preview_file_id
    WHERE m.path = 'Loot Studios/Dragon Knight' AND m.library_id = ${LIBRARY_ID}
  `)
  check('a creator-supplied image is chosen as the preview',
    preview.rows[0]?.filename === 'images/preview.png', preview.rows[0]?.filename ?? 'none')

  section('Search finds what was just indexed')
  for (const [query, expected] of [
    ['dragon', 'Dragon Knight'],
    ['troll', 'Forest Troll'],
    ['pokemon', 'Pokémon Gym 🏟'], // accent folding
    ['presupported', 'Dragon Knight'], // matches a word inside a filename path
  ] as const) {
    const hit = await db.execute<{ name: string }>(sql`
      SELECT name FROM models WHERE library_id = ${LIBRARY_ID}
        AND search_vector @@ websearch_to_tsquery('pm_search', ${query}) LIMIT 5
    `)
    check(`search "${query}" finds ${expected}`,
      hit.rows.some((r) => r.name === expected),
      hit.rows.map((r) => r.name).join(', ') || 'nothing')
  }

  section('Rescanning is idempotent')
  const second = await runScan()
  check('no models created on rescan', second.modelsCreated === 0, `${second.modelsCreated}`)
  check('no files created on rescan', second.filesCreated === 0, `${second.filesCreated}`)
  check('nothing marked missing', second.modelsMissing === 0)

  section('User edits survive a rescan')
  await db.execute(sql`
    UPDATE models SET name = 'Renamed By Hand', notes = 'my notes'
    WHERE path = 'benchy.stl' AND library_id = ${LIBRARY_ID}
  `)
  await runScan()
  const edited = await db.execute<{ name: string; notes: string }>(sql`
    SELECT name, notes FROM models WHERE path = 'benchy.stl' AND library_id = ${LIBRARY_ID}
  `)
  check('a hand-edited name is not overwritten', edited.rows[0]?.name === 'Renamed By Hand')
  check('hand-written notes survive', edited.rows[0]?.notes === 'my notes')

  section('Incremental changes')
  await mkdir(path.join(root, 'Terrain', 'New Keep'), { recursive: true })
  await writeFile(path.join(root, 'Terrain', 'New Keep', 'keep.stl'), 'k'.repeat(300))
  const added = await runScan({ mode: 'fast' })
  check('a fast scan finds a model added below an unchanged parent',
    added.modelsCreated === 1, `${added.modelsCreated} created`)

  section('SAFETY: unmounted volume must not wipe metadata')
  const before = (await models()).length
  await rm(root, { recursive: true, force: true })
  const vanished = await runScan()
  check('scan aborts when the root disappears', vanished.status === 'aborted')
  check('abort reason is storage_unavailable', vanished.abortReason === 'storage_unavailable')
  check('NOTHING was marked missing', (await missingCount()) === 0)
  check('every model is still indexed', (await models()).length === before)

  section('SAFETY: empty root with models on record')
  await mkdir(root, { recursive: true })
  const emptied = await runScan()
  check('scan aborts on an empty root', emptied.status === 'aborted')
  check('abort reason is empty_root', emptied.abortReason === 'empty_root')
  check('still nothing marked missing', (await missingCount()) === 0)

  section('SAFETY: mass disappearance')
  await buildLibrary() // restore everything except "New Keep"
  await runScan()
  const restored = (await models()).length
  await rm(path.join(root, 'Loot Studios'), { recursive: true, force: true })
  await rm(path.join(root, 'Terrain'), { recursive: true, force: true })
  const mass = await runScan()
  check('scan aborts when too much would disappear', mass.status === 'aborted')
  check('abort reason is mass_disappearance', mass.abortReason === 'mass_disappearance')
  check('explains the scale of the loss', /\d+ of \d+/.test(mass.abortDetail ?? ''), mass.abortDetail ?? '')
  check('models are preserved pending confirmation', (await models()).length === restored)

  section('An admin can confirm a genuine deletion')
  const forced = await runScan({ force: true })
  check('forced scan proceeds', forced.status === 'succeeded')
  check('models are now marked missing', forced.modelsMissing > 0, `${forced.modelsMissing}`)
  check('records are soft-deleted, not destroyed', (await missingCount()) > 0)

  section('A returning folder revives its record')
  const missingBefore = await missingCount()
  await buildLibrary()
  const revived = await runScan()
  check('scan succeeds', revived.status === 'succeeded')
  check('restored folders are revived', (await missingCount()) < missingBefore,
    `${missingBefore} -> ${await missingCount()}`)
  // "Terrain/New Keep" was created during the incremental test and is not part
  // of buildLibrary(), so it correctly stays missing.
  const stillMissing = await db.execute<{ path: string }>(sql`
    SELECT path FROM models WHERE library_id = ${LIBRARY_ID} AND missing_at IS NOT NULL
  `)
  check('only the genuinely absent folder is still missing',
    stillMissing.rows.every((r) => r.path === 'Terrain/New Keep'),
    stillMissing.rows.map((r) => r.path).join(', ') || 'none')
} catch (error) {
  console.error('\nUNEXPECTED ERROR:', error)
  failed++
} finally {
  section('Cleanup')
  await cleanup()
  check('library removed', true)
  await pool.end()
  console.log(`\n${passed} passed, ${failed} failed\n`)
  process.exit(failed > 0 ? 1 : 0)
}
