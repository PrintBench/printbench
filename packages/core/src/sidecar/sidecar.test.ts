import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { createDb } from '@pb/db'
import { LocalAdapter } from '../storage/local-adapter'
import type { LibraryLocation } from '../storage/types'
import { scanLibrary } from '../scan/scan-service'
import { updateModel } from '../services/model-service'
import { parseSidecar, serializeSidecar, sidecarUnchanged } from './sidecar'

describe('sidecar serialisation', () => {
  it('round-trips content', () => {
    const content = {
      name: 'Red Dragon',
      notes: 'A big one',
      license: 'CC-BY-4.0',
      creator: 'Loot Studios',
      tags: ['dragon', 'miniature'],
      previewFile: 'images/preview.png',
    }
    const { data } = parseSidecar(serializeSidecar(content))
    expect(data).toMatchObject(content)
  })

  /*
   * Rewriting identical metadata must produce identical bytes. A changed mtime
   * makes the containing directory look modified, which sends the next fast
   * scan back through a folder that has not actually changed.
   */
  it('sorts tags so unchanged metadata serialises identically', () => {
    const a = serializeSidecar({ name: 'X', tags: ['b', 'a', 'c'] })
    const b = serializeSidecar({ name: 'X', tags: ['c', 'b', 'a'] })
    // updatedAt differs, so compare everything else.
    const strip = (text: string) => text.replace(/"updatedAt":.*\n/, '')
    expect(strip(a)).toBe(strip(b))
  })

  it('detects unchanged content regardless of order', () => {
    expect(
      sidecarUnchanged({ name: 'X', tags: ['a', 'b'] }, { name: 'X', tags: ['b', 'a'] }),
    ).toBe(true)
    expect(sidecarUnchanged({ name: 'X', tags: ['a'] }, { name: 'X', tags: ['a', 'b'] })).toBe(false)
    expect(sidecarUnchanged(null, { name: 'X' })).toBe(false)
  })

  describe('tolerating bad input', () => {
    // A sidecar is metadata, not the model. Nothing here may break a scan.
    it('rejects invalid JSON without throwing', () => {
      const { data, error } = parseSidecar('{not json')
      expect(data).toBeNull()
      expect(error).toBeTruthy()
    })

    it('rejects an unexpected shape', () => {
      expect(parseSidecar('{"version":1,"tags":"not-an-array"}').data).toBeNull()
    })

    it('refuses a sidecar from a newer version rather than guessing', () => {
      // Reading it could silently drop fields it does not know about.
      const { data, error } = parseSidecar('{"version":99,"name":"X"}')
      expect(data).toBeNull()
      expect(error).toMatch(/newer/i)
    })

    it('accepts a minimal sidecar', () => {
      expect(parseSidecar('{"version":1}').data).toEqual({})
    })
  })
})

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

const LIBRARY_ID = '6a6a6a6a-0000-4000-8000-00000000side'.replace('side', 'a001')

describeDb('sidecar round trip', () => {
  let pool: ReturnType<typeof createDb>['pool']
  let db: ReturnType<typeof createDb>['db']
  let root: string
  let library: LibraryLocation

  const scan = () =>
    scanLibrary({ db, storage: new LocalAdapter(library), library }, { mode: 'deep' })

  beforeAll(async () => {
    ;({ pool, db } = createDb(url))
  })

  beforeEach(async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'pb-sidecar-'))
    root = path.join(base, 'library')
    library = { id: LIBRARY_ID, kind: 'in_place', backend: 'local', allowWrites: false, path: root }

    await mkdir(path.join(root, 'Red Dragon'), { recursive: true })
    await writeFile(path.join(root, 'Red Dragon', 'body.stl'), 'x'.repeat(500))
    await mkdir(path.join(root, 'Blue Dragon'), { recursive: true })
    await writeFile(path.join(root, 'Blue Dragon', 'body.stl'), 'y'.repeat(400))

    await db.execute(sql`DELETE FROM libraries WHERE id = ${LIBRARY_ID}`)
    await db.execute(sql`
      INSERT INTO libraries (id, name, kind, backend, path, write_sidecar)
      VALUES (${LIBRARY_ID}, 'Sidecar Fixture', 'in_place', 'local', ${root}, true)
    `)
  })

  afterEach(async () => {
    await db.execute(sql`DELETE FROM libraries WHERE id = ${LIBRARY_ID}`)
    await rm(path.dirname(root), { recursive: true, force: true })
  })

  afterAll(async () => {
    await pool.end()
  })

  async function modelId(modelPath: string): Promise<string> {
    const rows = await db.execute<{ id: string }>(
      sql`SELECT id FROM models WHERE library_id = ${LIBRARY_ID} AND path = ${modelPath}`,
    )
    return rows.rows[0]!.id
  }

  it('writes a sidecar when metadata is edited', async () => {
    await scan()
    const id = await modelId('Red Dragon')

    const result = await updateModel(db, id, {
      name: 'Red Dragon Miniature',
      license: 'CC-BY-4.0',
      creator: 'Loot Studios',
      tags: ['dragon', 'miniature'],
      notes: 'A big one',
    })

    expect(result.ok).toBe(true)
    expect(result.sidecarWritten).toBe(true)

    const written = await readFile(path.join(root, 'Red Dragon', '.printbench.json'), 'utf8')
    const { data } = parseSidecar(written)
    expect(data).toMatchObject({
      name: 'Red Dragon Miniature',
      license: 'CC-BY-4.0',
      creator: 'Loot Studios',
      tags: ['dragon', 'miniature'],
    })
  })

  it('never writes a sidecar into a library that opted out', async () => {
    await db.execute(sql`UPDATE libraries SET write_sidecar = false WHERE id = ${LIBRARY_ID}`)
    await scan()

    const result = await updateModel(db, await modelId('Red Dragon'), { name: 'Renamed' })

    expect(result.ok).toBe(true)
    expect(result.sidecarWritten).toBe(false)
    await expect(
      readFile(path.join(root, 'Red Dragon', '.printbench.json'), 'utf8'),
    ).rejects.toThrow()
  })

  it('does not rewrite an unchanged sidecar', async () => {
    await scan()
    const id = await modelId('Red Dragon')
    await updateModel(db, id, { name: 'Red Dragon', tags: ['dragon'] })

    // Saving the same values again must be a no-op on disk: a changed mtime
    // would make the next fast scan re-examine the folder for nothing.
    const second = await updateModel(db, id, { name: 'Red Dragon', tags: ['dragon'] })
    expect(second.sidecarWritten).toBe(false)
  })

  it('the sidecar is never treated as a model file', async () => {
    await scan()
    await updateModel(db, await modelId('Red Dragon'), { tags: ['dragon'] })
    await scan()

    const files = await db.execute<{ filename: string }>(sql`
      SELECT f.filename FROM model_files f JOIN models m ON m.id = f.model_id
      WHERE m.library_id = ${LIBRARY_ID}
    `)
    expect(files.rows.map((r) => r.filename)).not.toContain('.printbench.json')
  })

  /*
   * The restore drill, and the entire reason sidecars exist: lose the database
   * and a rescan brings the metadata back.
   */
  it('restores metadata after the database is lost', async () => {
    await scan()
    await updateModel(db, await modelId('Red Dragon'), {
      name: 'Red Dragon Miniature',
      license: 'CC-BY-4.0',
      creator: 'Loot Studios',
      tags: ['dragon', 'miniature'],
      notes: 'A fearsome beast',
    })

    // Simulate total loss of the database, keeping only the files on disk.
    await db.execute(sql`DELETE FROM models WHERE library_id = ${LIBRARY_ID}`)
    const gone = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM models WHERE library_id = ${LIBRARY_ID}`,
    )
    expect(gone.rows[0]!.n).toBe(0)

    const outcome = await scan()
    expect(outcome.status).toBe('succeeded')
    expect(outcome.sidecarsRestored).toBeGreaterThan(0)

    const restored = await db.execute<{
      name: string
      license: string
      notes: string
      creator: string
      tags: string[]
    }>(sql`
      SELECT m.name, m.license, m.notes, c.name AS creator,
             (SELECT array_agg(t.name ORDER BY t.name) FROM model_tags mt
                JOIN tags t ON t.id = mt.tag_id WHERE mt.model_id = m.id) AS tags
      FROM models m LEFT JOIN creators c ON c.id = m.creator_id
      WHERE m.library_id = ${LIBRARY_ID} AND m.path = 'Red Dragon'
    `)

    const row = restored.rows[0]!
    expect(row.name).toBe('Red Dragon Miniature')
    expect(row.license).toBe('CC-BY-4.0')
    expect(row.notes).toBe('A fearsome beast')
    expect(row.creator).toBe('Loot Studios')
    expect(row.tags.sort()).toEqual(['dragon', 'miniature'])
  })

  /*
   * A sidecar restores a NEW model only. Applying it on every scan would let a
   * stale file on disk overwrite an edit made in the app.
   */
  it('does not let a stale sidecar overwrite a later edit', async () => {
    await scan()
    const id = await modelId('Red Dragon')
    await updateModel(db, id, { name: 'Original Name', tags: ['old'] })

    // Rename in the app WITHOUT writing the sidecar, to mimic a stale file.
    await db.execute(sql`UPDATE models SET name = 'Newer Name' WHERE id = ${id}`)

    await scan()

    const after = await db.execute<{ name: string }>(
      sql`SELECT name FROM models WHERE id = ${id}`,
    )
    expect(after.rows[0]!.name).toBe('Newer Name')
  })

  it('ignores a corrupt sidecar rather than failing the scan', async () => {
    await writeFile(path.join(root, 'Blue Dragon', '.printbench.json'), '{ this is not json')

    const outcome = await scan()

    expect(outcome.status).toBe('succeeded')
    const models = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM models WHERE library_id = ${LIBRARY_ID}`,
    )
    expect(models.rows[0]!.n).toBe(2)
  })
})
