import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { createDb } from '@pb/db'
import { LocalAdapter } from '../storage/local-adapter'
import { scanLibrary } from '../scan/scan-service'
import type { LibraryLocation } from '../storage/types'
import {
  carryOutLibraryRemoval,
  libraryRemovalOptions,
  nestedLibraryRoots,
  previewLibraryDeletion,
  requestLibraryRemoval,
} from './library-removal-service'

/**
 * Removing a library: forgetting it, deleting its files, or moving its models
 * out first.
 *
 * Run against a real database and real folders, because the failures worth
 * catching are the two disagreeing: files deleted but the library kept with no
 * explanation, the library forgotten while files remain, or a deletion that
 * reaches into another library's folder.
 */

const UPLOADS = '4e000000-0000-4000-8000-000000000201'
const OTHER_UPLOADS = '4e000000-0000-4000-8000-000000000202'
const EXISTING = '4e000000-0000-4000-8000-000000000203'
const NESTED = '4e000000-0000-4000-8000-000000000204'
const ALL = [UPLOADS, OTHER_UPLOADS, EXISTING, NESTED]

describe('removing a library', { tags: ['integration'] }, () => {
  let pool: ReturnType<typeof createDb>['pool']
  let db: ReturnType<typeof createDb>['db']
  let base = ''
  let uploadsRoot = ''
  let otherRoot = ''
  let existingRoot = ''

  const location = (id: string, root: string, kind: 'in_place' | 'managed'): LibraryLocation => ({
    id,
    kind,
    backend: 'local',
    allowWrites: kind === 'managed',
    path: root,
  })

  function stl(): Buffer {
    const buffer = Buffer.alloc(84 + 50)
    buffer.writeUInt32LE(1, 80)
    return buffer
  }

  async function exists(file: string): Promise<boolean> {
    return stat(file).then(
      () => true,
      () => false,
    )
  }

  async function libraryRow(id: string) {
    const rows = await db.execute<{ removal_mode: string | null; removal_error: string | null }>(
      sql`SELECT removal_mode, removal_error FROM libraries WHERE id = ${id}`,
    )
    return rows.rows[0] ?? null
  }

  async function modelLibraries(): Promise<Record<string, string>> {
    const rows = await db.execute<{ name: string; library_id: string }>(
      sql`SELECT name, library_id FROM models WHERE library_id IN (${UPLOADS}, ${OTHER_UPLOADS})`,
    )
    return Object.fromEntries(rows.rows.map((row) => [row.name, row.library_id]))
  }

  beforeAll(() => {
    ;({ pool, db } = createDb())
  })

  afterAll(async () => {
    await cleanup()
    if (base) await rm(base, { recursive: true, force: true })
    await pool.end()
  })

  beforeEach(async () => {
    await cleanup()
    if (base) await rm(base, { recursive: true, force: true })

    base = await mkdtemp(path.join(tmpdir(), 'pb-remove-lib-'))
    uploadsRoot = path.join(base, 'uploads')
    otherRoot = path.join(base, 'more-uploads')
    existingRoot = path.join(base, 'existing')

    await mkdir(path.join(uploadsRoot, 'Red Dragon', 'stl'), { recursive: true })
    await writeFile(path.join(uploadsRoot, 'Red Dragon', 'body.stl'), stl())
    await writeFile(path.join(uploadsRoot, 'Red Dragon', 'stl', 'wing.stl'), stl())
    await writeFile(path.join(uploadsRoot, 'benchy.stl'), stl())
    // Not a model file and never indexed, but in the library's folder.
    await writeFile(path.join(uploadsRoot, 'notes.txt'), 'scratch')
    // Another library's folder, inside this one.
    await mkdir(path.join(uploadsRoot, 'shared', 'Kept Model'), { recursive: true })
    await writeFile(path.join(uploadsRoot, 'shared', 'Kept Model', 'kept.stl'), stl())

    await mkdir(otherRoot, { recursive: true })
    await mkdir(path.join(existingRoot, 'Theirs'), { recursive: true })
    await writeFile(path.join(existingRoot, 'Theirs', 'theirs.stl'), stl())

    await db.execute(sql`
      INSERT INTO libraries (id, name, kind, backend, path, allow_writes, write_sidecar) VALUES
        (${UPLOADS}, 'Uploads', 'managed', 'local', ${uploadsRoot}, true, false),
        (${OTHER_UPLOADS}, 'More Uploads', 'managed', 'local', ${otherRoot}, true, false),
        (${EXISTING}, 'Existing', 'in_place', 'local', ${existingRoot}, false, false),
        (${NESTED}, 'Nested', 'in_place', 'local', ${path.join(uploadsRoot, 'shared')}, false, false)`)

    const where = location(UPLOADS, uploadsRoot, 'managed')
    await scanLibrary({ db, storage: new LocalAdapter(where), library: where }, { mode: 'deep' })
  })

  async function cleanup() {
    await db.execute(sql`DELETE FROM libraries WHERE id IN ${sql.raw(`('${ALL.join("','")}')`)}`)
  }

  it('offers nothing but forgetting for a library of existing files', async () => {
    const options = await libraryRemovalOptions(db, EXISTING)
    expect(options).toMatchObject({ canDeleteFiles: false, canMove: false })
    expect(options.reason).toMatch(/never deleted or moved/)

    const refused = await requestLibraryRemoval(db, EXISTING, { mode: 'delete_files' })
    expect(refused.ok).toBe(false)
    expect(await libraryRow(EXISTING)).toMatchObject({ removal_mode: null })
  })

  it('offers both for an uploads library, moving only into another uploads library', async () => {
    const options = await libraryRemovalOptions(db, UPLOADS)
    expect(options).toMatchObject({ canDeleteFiles: true, canMove: true, reason: null })
    expect(options.destinations).toEqual([{ id: OTHER_UPLOADS, name: 'More Uploads' }])

    const intoExisting = await requestLibraryRemoval(db, UPLOADS, {
      mode: 'move',
      destinationLibraryId: EXISTING,
    })
    expect(intoExisting.ok).toBe(false)
  })

  it('forgets a library at once and leaves every file', async () => {
    const result = await requestLibraryRemoval(db, UPLOADS, { mode: 'forget' })
    expect(result).toMatchObject({ ok: true, data: { queued: false } })
    expect(await libraryRow(UPLOADS)).toBeNull()
    expect(await exists(path.join(uploadsRoot, 'Red Dragon', 'body.stl'))).toBe(true)
  })

  it('finds libraries nested inside, so deleting never reaches them', async () => {
    expect(await nestedLibraryRoots(db, UPLOADS)).toEqual(['shared'])
    expect(await nestedLibraryRoots(db, OTHER_UPLOADS)).toEqual([])
  })

  it('counts what would be deleted before anything is', async () => {
    const preview = await previewLibraryDeletion(db, UPLOADS)
    expect(preview).toMatchObject({
      ok: true,
      data: { files: 4, bytes: 134 * 3 + 7, truncated: false, nested: ['shared'] },
    })
    expect(await exists(path.join(uploadsRoot, 'benchy.stl'))).toBe(true)
  })

  it('deletes everything in the folder except a nested library, then removes the library', async () => {
    const requested = await requestLibraryRemoval(db, UPLOADS, { mode: 'delete_files' })
    expect(requested).toMatchObject({ ok: true, data: { queued: true } })
    expect(await libraryRow(UPLOADS)).toMatchObject({ removal_mode: 'delete_files' })

    const outcome = await carryOutLibraryRemoval(db, UPLOADS)
    expect(outcome).toMatchObject({ status: 'removed', filesDeleted: 4, failures: [] })

    expect(await libraryRow(UPLOADS)).toBeNull()
    // Only the nested library's folder is left, untouched.
    expect(await readdir(uploadsRoot)).toEqual(['shared'])
    expect(await exists(path.join(uploadsRoot, 'shared', 'Kept Model', 'kept.stl'))).toBe(true)
    expect(await libraryRow(NESTED)).not.toBeNull()
  })

  it('moves every model with its row, then removes the empty library', async () => {
    const before = await modelLibraries()
    expect(Object.values(before).every((id) => id === UPLOADS)).toBe(true)
    const ids = await db.execute<{ id: string }>(
      sql`SELECT id FROM models WHERE library_id = ${UPLOADS} ORDER BY id`,
    )

    await requestLibraryRemoval(db, UPLOADS, { mode: 'move', destinationLibraryId: OTHER_UPLOADS })
    const outcome = await carryOutLibraryRemoval(db, UPLOADS)
    expect(outcome).toMatchObject({ status: 'removed', modelsMoved: ids.rows.length, failures: [] })

    expect(await libraryRow(UPLOADS)).toBeNull()
    // The same rows, now in the other library: the ids, and what hangs off them, survive.
    const after = await db.execute<{ id: string }>(
      sql`SELECT id FROM models WHERE library_id = ${OTHER_UPLOADS} ORDER BY id`,
    )
    expect(after.rows).toEqual(ids.rows)
    expect(await exists(path.join(otherRoot, 'Red Dragon', 'stl', 'wing.stl'))).toBe(true)
  })

  it('keeps the library, with the reason, when a model cannot be moved', async () => {
    // A model already at the same path in the destination blocks that one move.
    await mkdir(path.join(otherRoot, 'Red Dragon'), { recursive: true })
    await writeFile(path.join(otherRoot, 'Red Dragon', 'body.stl'), stl())
    const where = location(OTHER_UPLOADS, otherRoot, 'managed')
    await scanLibrary({ db, storage: new LocalAdapter(where), library: where }, { mode: 'deep' })

    await requestLibraryRemoval(db, UPLOADS, { mode: 'move', destinationLibraryId: OTHER_UPLOADS })
    const outcome = await carryOutLibraryRemoval(db, UPLOADS)

    expect(outcome.status).toBe('stopped')
    expect(outcome.modelsMoved).toBeGreaterThan(0)
    expect(outcome.failures.join()).toMatch(/Red Dragon/)

    const row = await libraryRow(UPLOADS)
    expect(row?.removal_mode).toBeNull()
    expect(row?.removal_error).toMatch(/could not be moved.*remove it again to retry/)
    expect(await exists(path.join(uploadsRoot, 'Red Dragon', 'body.stl'))).toBe(true)
  })

  it('refuses a second request, and removing the library a move is heading into', async () => {
    await requestLibraryRemoval(db, UPLOADS, { mode: 'move', destinationLibraryId: OTHER_UPLOADS })

    const again = await requestLibraryRemoval(db, UPLOADS, { mode: 'delete_files' })
    expect(again).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already being removed/),
    })

    const destination = await requestLibraryRemoval(db, OTHER_UPLOADS, { mode: 'forget' })
    expect(destination).toMatchObject({ ok: false, error: expect.stringMatching(/Wait for that/) })
    expect(await libraryRow(OTHER_UPLOADS)).not.toBeNull()
  })

  it('does nothing for a library with no removal recorded', async () => {
    expect((await carryOutLibraryRemoval(db, UPLOADS)).status).toBe('nothing_to_do')
    expect(await libraryRow(UPLOADS)).not.toBeNull()
  })
})
