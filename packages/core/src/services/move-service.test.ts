import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { createDb } from '@pb/db'
import { MoveError, moveModelToLibrary } from './move-service'
import { removeModel } from './delete-service'
import { LocalAdapter } from '../storage/local-adapter'
import { scanLibrary } from '../scan/scan-service'
import type { LibraryLocation, StorageAdapter } from '../storage/types'

/**
 * Moving a model between libraries.
 *
 * The reason this exists rather than "delete it and upload it again" is
 * everything hanging off the model row — tags, notes, collections, print
 * history, the share link — so most of what is asserted here is that those
 * survive, along with the id they hang from.
 *
 * Run against a real database and a real filesystem. The interesting failures
 * are all about two systems disagreeing: files moved but the row not updated,
 * a row updated but files left behind, a scan afterwards undoing either.
 */
const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

const SOURCE = '4d000000-0000-4000-8000-000000000101'
const DESTINATION = '4d000000-0000-4000-8000-000000000102'
const READ_ONLY = '4d000000-0000-4000-8000-000000000103'

describeDb('moving a model between libraries', () => {
  let pool: ReturnType<typeof createDb>['pool']
  let db: ReturnType<typeof createDb>['db']
  let base = ''
  let sourceRoot = ''
  let destinationRoot = ''
  let readOnlyRoot = ''

  const location = (id: string, root: string, kind: 'in_place' | 'managed'): LibraryLocation => ({
    id,
    kind,
    backend: 'local',
    allowWrites: kind === 'managed',
    path: root,
  })

  const sourceAdapter = () => new LocalAdapter(location(SOURCE, sourceRoot, 'managed'))
  const destinationAdapter = () =>
    new LocalAdapter(location(DESTINATION, destinationRoot, 'managed'))

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

    base = await mkdtemp(path.join(tmpdir(), 'pb-move-svc-'))
    sourceRoot = path.join(base, 'wrong-library')
    destinationRoot = path.join(base, 'right-library')
    readOnlyRoot = path.join(base, 'mine')

    // A folder model with several files, and a loose one. Both shapes move.
    await mkdir(path.join(sourceRoot, 'Red Dragon', 'stl'), { recursive: true })
    await writeFile(path.join(sourceRoot, 'Red Dragon', 'body.stl'), stl())
    await writeFile(path.join(sourceRoot, 'Red Dragon', 'stl', 'wing.stl'), stl())
    await writeFile(path.join(sourceRoot, 'Red Dragon', 'readme.txt'), 'notes')
    await writeFile(path.join(sourceRoot, 'benchy.stl'), stl())

    await mkdir(destinationRoot, { recursive: true })
    await mkdir(path.join(readOnlyRoot, 'Theirs'), { recursive: true })
    await writeFile(path.join(readOnlyRoot, 'Theirs', 'theirs.stl'), stl())

    await db.execute(sql`
      INSERT INTO libraries (id, name, kind, backend, path, allow_writes, write_sidecar) VALUES
        (${SOURCE}, 'Wrong Library', 'managed', 'local', ${sourceRoot}, true, false),
        (${DESTINATION}, 'Right Library', 'managed', 'local', ${destinationRoot}, true, false),
        (${READ_ONLY}, 'My Own Files', 'in_place', 'local', ${readOnlyRoot}, false, false)`)

    for (const [id, root, kind] of [
      [SOURCE, sourceRoot, 'managed'],
      [DESTINATION, destinationRoot, 'managed'],
      [READ_ONLY, readOnlyRoot, 'in_place'],
    ] as const) {
      const where = location(id, root, kind)
      await scanLibrary({ db, storage: new LocalAdapter(where), library: where }, { mode: 'deep' })
    }
  })

  async function cleanup() {
    await db.execute(
      sql`DELETE FROM libraries WHERE id IN (${SOURCE}, ${DESTINATION}, ${READ_ONLY})`,
    )
  }

  /** A minimal valid binary STL: 80-byte header, one triangle. */
  function stl(): Buffer {
    const buffer = Buffer.alloc(84 + 50)
    buffer.writeUInt32LE(1, 80)
    return buffer
  }

  const modelId = async (libraryId: string, name: string): Promise<string> => {
    const rows = await db.execute<{ id: string }>(
      sql`SELECT id FROM models WHERE library_id = ${libraryId} AND name = ${name} LIMIT 1`,
    )
    if (!rows.rows[0]) throw new Error(`no model named ${name}`)
    return rows.rows[0].id
  }

  const modelRow = async (id: string) => {
    const rows = await db.execute<{
      library_id: string
      path: string
      public_id: string
      name: string
      notes: string | null
      missing_at: string | null
      file_count: number
    }>(sql`SELECT * FROM models WHERE id = ${id}`)
    return rows.rows[0]
  }

  const modelNames = async (libraryId: string): Promise<string[]> => {
    const rows = await db.execute<{ name: string }>(
      sql`SELECT name FROM models WHERE library_id = ${libraryId} ORDER BY name`,
    )
    return rows.rows.map((row) => row.name)
  }

  const rescan = async (id: string, root: string) => {
    const where = location(id, root, 'managed')
    return scanLibrary({ db, storage: new LocalAdapter(where), library: where }, { mode: 'deep' })
  }

  const exists = (absolute: string) =>
    stat(absolute).then(
      () => true,
      () => false,
    )

  describe('a folder model', () => {
    it('lands in the destination library, files and all', async () => {
      const id = await modelId(SOURCE, 'Red Dragon')
      const result = await moveModelToLibrary(db, sourceAdapter(), destinationAdapter(), id)

      expect(result.filesMoved).toBe(3)
      expect(result.to).toEqual({ libraryId: DESTINATION, path: 'Red Dragon' })

      expect((await readdir(path.join(destinationRoot, 'Red Dragon'))).sort()).toEqual([
        'body.stl',
        'readme.txt',
        'stl',
      ])
      expect(await readdir(path.join(destinationRoot, 'Red Dragon', 'stl'))).toEqual(['wing.stl'])
    })

    it('repoints the row without replacing it', async () => {
      const id = await modelId(SOURCE, 'Red Dragon')
      const before = await modelRow(id)

      await moveModelToLibrary(db, sourceAdapter(), destinationAdapter(), id)

      const after = await modelRow(id)
      expect(after!.library_id).toBe(DESTINATION)
      expect(after!.path).toBe('Red Dragon')
      // The share link is this column. A new row means every link already sent
      // out stops working, which is the delete-and-reupload behaviour this is
      // meant to replace.
      expect(after!.public_id).toBe(before!.public_id)
    })

    it('carries the metadata that a delete-and-reupload would lose', async () => {
      const id = await modelId(SOURCE, 'Red Dragon')
      await db.execute(sql`UPDATE models SET notes = 'supports at 30°' WHERE id = ${id}`)
      await db.execute(sql`
        INSERT INTO tags (name, slug) VALUES ('dragons', 'dragons')
        ON CONFLICT (slug) DO NOTHING`)
      await db.execute(sql`
        INSERT INTO model_tags (model_id, tag_id)
        SELECT ${id}, id FROM tags WHERE slug = 'dragons'`)

      await moveModelToLibrary(db, sourceAdapter(), destinationAdapter(), id)

      expect((await modelRow(id))!.notes).toBe('supports at 30°')
      const tags = await db.execute<{ slug: string }>(sql`
        SELECT t.slug FROM model_tags mt JOIN tags t ON t.id = mt.tag_id
        WHERE mt.model_id = ${id}`)
      expect(tags.rows.map((row) => row.slug)).toEqual(['dragons'])
    })

    it('keeps the file rows, so thumbnails and digests are not re-derived', async () => {
      const id = await modelId(SOURCE, 'Red Dragon')
      const before = await db.execute<{ id: string; filename: string }>(
        sql`SELECT id, filename FROM model_files WHERE model_id = ${id} ORDER BY filename`,
      )

      await moveModelToLibrary(db, sourceAdapter(), destinationAdapter(), id)

      const after = await db.execute<{ id: string; filename: string }>(
        sql`SELECT id, filename FROM model_files WHERE model_id = ${id} ORDER BY filename`,
      )
      expect(after.rows).toEqual(before.rows)
    })

    it('takes the folder out of the source library', async () => {
      const id = await modelId(SOURCE, 'Red Dragon')
      await moveModelToLibrary(db, sourceAdapter(), destinationAdapter(), id)

      expect(await exists(path.join(sourceRoot, 'Red Dragon'))).toBe(false)
      expect(await modelNames(SOURCE)).toEqual(['Benchy'])
    })

    it('renames on the way when a destination path is given', async () => {
      const id = await modelId(SOURCE, 'Red Dragon')
      await moveModelToLibrary(db, sourceAdapter(), destinationAdapter(), id, {
        destinationPath: 'Dragons/Red Dragon',
      })

      expect(await exists(path.join(destinationRoot, 'Dragons', 'Red Dragon', 'body.stl'))).toBe(
        true,
      )
      expect((await modelRow(id))!.path).toBe('Dragons/Red Dragon')
    })
  })

  describe('a single loose file', () => {
    it('moves the file itself, which is its whole model', async () => {
      const id = await modelId(SOURCE, 'Benchy')
      await moveModelToLibrary(db, sourceAdapter(), destinationAdapter(), id)

      expect(await exists(path.join(destinationRoot, 'benchy.stl'))).toBe(true)
      expect(await exists(path.join(sourceRoot, 'benchy.stl'))).toBe(false)
      expect((await modelRow(id))!.path).toBe('benchy.stl')
    })
  })

  /*
   * The half that decides whether this is usable. A scan runs on a schedule,
   * so it WILL follow a move without being asked — and if it treats the moved
   * folder as a new model, or the vacated one as a deletion, the move silently
   * comes apart some minutes after it appeared to work.
   */
  describe('the scans that follow', () => {
    it('is adopted by the destination scan rather than duplicated', async () => {
      const id = await modelId(SOURCE, 'Red Dragon')
      await moveModelToLibrary(db, sourceAdapter(), destinationAdapter(), id)

      const outcome = await rescan(DESTINATION, destinationRoot)

      expect(outcome.modelsCreated).toBe(0)
      expect(await modelNames(DESTINATION)).toEqual(['Red Dragon'])
      expect((await modelRow(id))!.library_id).toBe(DESTINATION)
    })

    it('is not resurrected by the source scan', async () => {
      const id = await modelId(SOURCE, 'Red Dragon')
      await moveModelToLibrary(db, sourceAdapter(), destinationAdapter(), id)

      await rescan(SOURCE, sourceRoot)

      expect(await modelNames(SOURCE)).toEqual(['Benchy'])
      expect((await modelRow(id))!.missing_at).toBeNull()
    })

    it('survives a scan of both, in either order', async () => {
      const id = await modelId(SOURCE, 'Red Dragon')
      await moveModelToLibrary(db, sourceAdapter(), destinationAdapter(), id)

      await rescan(SOURCE, sourceRoot)
      await rescan(DESTINATION, destinationRoot)

      const after = await modelRow(id)
      expect(after!.library_id).toBe(DESTINATION)
      expect(after!.missing_at).toBeNull()
      expect(after!.file_count).toBe(3)
    })

    it('is not suppressed by a stale exclusion at the destination', async () => {
      /*
       * The destination remembers a model removed from that exact path once
       * before. Left in place, the next scan there skips the folder and the
       * model just moved in is marked missing — a removal outliving the model
       * it was about.
       */
      await mkdir(path.join(destinationRoot, 'Red Dragon'), { recursive: true })
      await writeFile(path.join(destinationRoot, 'Red Dragon', 'old.stl'), stl())
      await rescan(DESTINATION, destinationRoot)
      await removeModel(db, await modelId(DESTINATION, 'Red Dragon'))
      await rm(path.join(destinationRoot, 'Red Dragon'), { recursive: true, force: true })

      const id = await modelId(SOURCE, 'Red Dragon')
      await moveModelToLibrary(db, sourceAdapter(), destinationAdapter(), id)
      await rescan(DESTINATION, destinationRoot)

      expect((await modelRow(id))!.missing_at).toBeNull()
      expect(await modelNames(DESTINATION)).toEqual(['Red Dragon'])
    })
  })

  describe('refusals', () => {
    it('refuses to take a model out of a read-only library', async () => {
      const readOnly = new LocalAdapter(location(READ_ONLY, readOnlyRoot, 'in_place'))
      const id = await modelId(READ_ONLY, 'Theirs')

      await expect(
        moveModelToLibrary(db, readOnly, destinationAdapter(), id),
      ).rejects.toBeInstanceOf(MoveError)

      // The promise: not one byte of somebody's own folder was touched.
      expect(await exists(path.join(readOnlyRoot, 'Theirs', 'theirs.stl'))).toBe(true)
      expect((await modelRow(id))!.library_id).toBe(READ_ONLY)
    })

    it('refuses to put a model into a read-only library', async () => {
      const readOnly = new LocalAdapter(location(READ_ONLY, readOnlyRoot, 'in_place'))
      const id = await modelId(SOURCE, 'Red Dragon')

      await expect(moveModelToLibrary(db, sourceAdapter(), readOnly, id)).rejects.toBeInstanceOf(
        MoveError,
      )
      expect(await exists(path.join(sourceRoot, 'Red Dragon', 'body.stl'))).toBe(true)
    })

    it('refuses when another model already claims the destination path', async () => {
      await mkdir(path.join(destinationRoot, 'Red Dragon'), { recursive: true })
      await writeFile(path.join(destinationRoot, 'Red Dragon', 'other.stl'), stl())
      await rescan(DESTINATION, destinationRoot)

      const id = await modelId(SOURCE, 'Red Dragon')
      await expect(
        moveModelToLibrary(db, sourceAdapter(), destinationAdapter(), id),
      ).rejects.toThrow(/already at Red Dragon/)

      // Refused before anything moved, so both models are still intact.
      expect(await exists(path.join(sourceRoot, 'Red Dragon', 'body.stl'))).toBe(true)
      expect(await readFile(path.join(destinationRoot, 'Red Dragon', 'other.stl'))).toHaveLength(
        134,
      )
    })

    it('refuses when files sit at the destination path with no model yet', async () => {
      // Uploaded but not yet scanned. The index says the path is free and it
      // is not; moving into it would merge two models into one folder.
      await mkdir(path.join(destinationRoot, 'Red Dragon'), { recursive: true })
      await writeFile(path.join(destinationRoot, 'Red Dragon', 'stranger.stl'), stl())

      const id = await modelId(SOURCE, 'Red Dragon')
      await expect(
        moveModelToLibrary(db, sourceAdapter(), destinationAdapter(), id),
      ).rejects.toThrow(/already files at Red Dragon/)
      expect(await exists(path.join(sourceRoot, 'Red Dragon', 'body.stl'))).toBe(true)
    })

    it('refuses a move into the library it is already in', async () => {
      const id = await modelId(SOURCE, 'Red Dragon')
      await expect(moveModelToLibrary(db, sourceAdapter(), sourceAdapter(), id)).rejects.toThrow(
        /already in that library/,
      )
    })

    it('refuses while either library is being scanned', async () => {
      await db.execute(sql`
        INSERT INTO scan_runs (library_id, status, mode) VALUES (${DESTINATION}, 'running', 'fast')`)

      const id = await modelId(SOURCE, 'Red Dragon')
      await expect(
        moveModelToLibrary(db, sourceAdapter(), destinationAdapter(), id),
      ).rejects.toThrow(/being scanned/)
      expect(await exists(path.join(sourceRoot, 'Red Dragon', 'body.stl'))).toBe(true)
    })

    it('refuses a source adapter built from the wrong library', async () => {
      // Would otherwise read files from one library and record the move
      // against another, which is a corrupt row rather than an error.
      const id = await modelId(SOURCE, 'Red Dragon')
      await expect(
        moveModelToLibrary(db, destinationAdapter(), sourceAdapter(), id),
      ).rejects.toThrow(/not in the library/)
    })
  })

  describe('when a file cannot be moved', () => {
    /** Fails on one named file, after the others have gone across. */
    function failingOn(filename: string, adapter: StorageAdapter): StorageAdapter {
      return new Proxy(adapter, {
        get(target, property, receiver) {
          if (property === 'adoptFrom') {
            return async (source: StorageAdapter, from: string, to: string) => {
              if (to.endsWith(filename)) throw new Error('disk full')
              return target.adoptFrom!(source, from, to)
            }
          }
          return Reflect.get(target, property, receiver) as unknown
        },
      }) as StorageAdapter
    }

    it('puts back the files that had already moved', async () => {
      const id = await modelId(SOURCE, 'Red Dragon')

      await expect(
        moveModelToLibrary(db, sourceAdapter(), failingOn('readme.txt', destinationAdapter()), id),
      ).rejects.toThrow(/disk full/)

      // Every file back where it started, and nothing left behind in the
      // destination for the next scan there to invent a half-model from.
      expect((await readdir(path.join(sourceRoot, 'Red Dragon'))).sort()).toEqual([
        'body.stl',
        'readme.txt',
        'stl',
      ])
      expect(await readdir(destinationRoot)).toEqual([])
    })

    it('leaves the row in the source library', async () => {
      const id = await modelId(SOURCE, 'Red Dragon')

      await expect(
        moveModelToLibrary(db, sourceAdapter(), failingOn('body.stl', destinationAdapter()), id),
      ).rejects.toThrow(MoveError)

      const after = await modelRow(id)
      expect(after!.library_id).toBe(SOURCE)
      expect(after!.path).toBe('Red Dragon')
    })

    it('a rescan afterwards finds the model exactly as it was', async () => {
      const id = await modelId(SOURCE, 'Red Dragon')
      await expect(
        moveModelToLibrary(db, sourceAdapter(), failingOn('readme.txt', destinationAdapter()), id),
      ).rejects.toThrow(MoveError)

      await rescan(SOURCE, sourceRoot)
      await rescan(DESTINATION, destinationRoot)

      expect(await modelNames(SOURCE)).toEqual(['Benchy', 'Red Dragon'])
      expect(await modelNames(DESTINATION)).toEqual([])
      expect((await modelRow(id))!.missing_at).toBeNull()
    })
  })

  describe('the source folder', () => {
    it('is left in place when something unindexed is still in it', async () => {
      // A file the scanner ignores is still the user's file. Removing the
      // folder to tidy up would delete it.
      await writeFile(path.join(sourceRoot, 'Red Dragon', 'Thumbs.db'), 'junk')

      const id = await modelId(SOURCE, 'Red Dragon')
      const result = await moveModelToLibrary(db, sourceAdapter(), destinationAdapter(), id)

      expect(result.sourceFolderKept).toBe(true)
      expect(await readdir(path.join(sourceRoot, 'Red Dragon'))).toEqual(['Thumbs.db'])
    })

    it('takes the sidecar with it rather than leaving a ghost behind', async () => {
      /*
       * The sidecar is deliberately not one of a model's files, so nothing
       * above moves it — and a folder containing only a sidecar still reads to
       * the scanner as a model, which is the model that just left reappearing
       * empty at the next scan.
       */
      await writeFile(
        path.join(sourceRoot, 'Red Dragon', '.printbench.json'),
        JSON.stringify({ version: 1, name: 'Red Dragon' }),
      )

      const id = await modelId(SOURCE, 'Red Dragon')
      const result = await moveModelToLibrary(db, sourceAdapter(), destinationAdapter(), id)

      expect(result.sourceFolderKept).toBe(false)
      expect(await exists(path.join(sourceRoot, 'Red Dragon'))).toBe(false)

      await rescan(SOURCE, sourceRoot)
      expect(await modelNames(SOURCE)).toEqual(['Benchy'])
    })
  })
})
