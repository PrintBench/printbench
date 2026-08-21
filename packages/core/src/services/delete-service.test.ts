import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { createDb } from '@pb/db'
import {
  DeleteError,
  deleteModelFiles,
  excludedPaths,
  listExclusions,
  removeModel,
  restoreExclusion,
} from './delete-service'
import { LocalAdapter } from '../storage/local-adapter'
import { scanLibrary } from '../scan/scan-service'
import type { LibraryLocation } from '../storage/types'

/**
 * Deleting models.
 *
 * Most of this is about what is NOT deleted. The application's central promise
 * is that it does not modify files it did not create, so removing a model from
 * a library pointed at somebody's own folders must leave every byte where it
 * was — and a scan must not then put the model straight back, which is the
 * failure that makes a delete button look broken.
 */
const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

const IN_PLACE = '4d000000-0000-4000-8000-000000000001'
const MANAGED = '4d000000-0000-4000-8000-000000000002'

describeDb('deleting models', () => {
  let pool: ReturnType<typeof createDb>['pool']
  let db: ReturnType<typeof createDb>['db']
  let base = ''
  let inPlaceRoot = ''
  let managedRoot = ''

  const location = (id: string, root: string, kind: 'in_place' | 'managed'): LibraryLocation => ({
    id,
    kind,
    backend: 'local',
    allowWrites: kind === 'managed',
    path: root,
  })

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

    base = await mkdtemp(path.join(tmpdir(), 'pb-del-'))
    inPlaceRoot = path.join(base, 'mine')
    managedRoot = path.join(base, 'uploads')

    for (const root of [inPlaceRoot, managedRoot]) {
      await mkdir(path.join(root, 'Keep Me'), { recursive: true })
      await mkdir(path.join(root, 'Remove Me'), { recursive: true })
      await writeFile(path.join(root, 'Keep Me', 'keep.stl'), stl())
      await writeFile(path.join(root, 'Remove Me', 'gone.stl'), stl())
    }

    await db.execute(sql`
      INSERT INTO libraries (id, name, kind, backend, path, allow_writes) VALUES
        (${IN_PLACE}, 'My Own Files', 'in_place', 'local', ${inPlaceRoot}, false),
        (${MANAGED}, 'Uploads', 'managed', 'local', ${managedRoot}, true)`)

    for (const [id, root, kind] of [
      [IN_PLACE, inPlaceRoot, 'in_place'],
      [MANAGED, managedRoot, 'managed'],
    ] as const) {
      const where = location(id, root, kind)
      await scanLibrary({ db, storage: new LocalAdapter(where), library: where }, { mode: 'deep' })
    }
  })

  async function cleanup() {
    await db.execute(sql`DELETE FROM libraries WHERE id IN (${IN_PLACE}, ${MANAGED})`)
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

  const modelNames = async (libraryId: string): Promise<string[]> => {
    const rows = await db.execute<{ name: string }>(
      sql`SELECT name FROM models WHERE library_id = ${libraryId} ORDER BY name`,
    )
    return rows.rows.map((row) => row.name)
  }

  describe('removing from the library', () => {
    it('forgets the model', async () => {
      await removeModel(db, await modelId(IN_PLACE, 'Remove Me'))
      expect(await modelNames(IN_PLACE)).toEqual(['Keep Me'])
    })

    /*
     * The promise. A library pointed at somebody's own folders is never
     * written to, and "delete" in the app must not become "delete" on disk.
     */
    it('leaves every file exactly where it was', async () => {
      await removeModel(db, await modelId(IN_PLACE, 'Remove Me'))

      const folders = await readdir(inPlaceRoot)
      expect(folders.sort()).toEqual(['Keep Me', 'Remove Me'])
      expect(await readdir(path.join(inPlaceRoot, 'Remove Me'))).toEqual(['gone.stl'])
    })

    it('reports that the files were kept', async () => {
      const result = await removeModel(db, await modelId(IN_PLACE, 'Remove Me'))
      expect(result.filesKept).toBe(true)
      expect(result.name).toBe('Remove Me')
    })

    /*
     * Without an exclusion the next scan walks the same folder, finds the same
     * files and recreates the model — so the button appears to work until the
     * next scan puts everything back.
     */
    it('does not come back on the next scan', async () => {
      await removeModel(db, await modelId(IN_PLACE, 'Remove Me'))

      const where = location(IN_PLACE, inPlaceRoot, 'in_place')
      const outcome = await scanLibrary(
        { db, storage: new LocalAdapter(where), library: where },
        { mode: 'deep' },
      )

      expect(await modelNames(IN_PLACE)).toEqual(['Keep Me'])
      expect(outcome.modelsExcluded).toBe(1)
    })

    it('does not suppress anything else', async () => {
      await removeModel(db, await modelId(IN_PLACE, 'Remove Me'))

      const where = location(IN_PLACE, inPlaceRoot, 'in_place')
      await scanLibrary({ db, storage: new LocalAdapter(where), library: where }, { mode: 'deep' })

      expect(await modelNames(IN_PLACE)).toContain('Keep Me')
    })

    it('is scoped to its own library', async () => {
      // The same folder name exists in both fixtures.
      await removeModel(db, await modelId(IN_PLACE, 'Remove Me'))
      expect(await modelNames(MANAGED)).toContain('Remove Me')

      const paths = await excludedPaths(db, MANAGED)
      expect(paths.size).toBe(0)
    })

    it('takes the print history and tags with it', async () => {
      const id = await modelId(IN_PLACE, 'Remove Me')
      await db.execute(sql`INSERT INTO print_runs (model_id, status) VALUES (${id}, 'success')`)

      await removeModel(db, id)

      const prints = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM print_runs WHERE model_id = ${id}`,
      )
      expect(prints.rows[0]!.n).toBe(0)
    })

    it('refuses a model that is already gone', async () => {
      await expect(
        removeModel(db, '4dff0000-0000-4000-8000-0000000000ff'),
      ).rejects.toThrow(DeleteError)
    })
  })

  describe('restoring', () => {
    it('brings the model back at the next scan', async () => {
      const id = await modelId(IN_PLACE, 'Remove Me')
      const { path: removedPath } = await removeModel(db, id)

      expect(await restoreExclusion(db, IN_PLACE, removedPath)).toBe(true)

      const where = location(IN_PLACE, inPlaceRoot, 'in_place')
      await scanLibrary({ db, storage: new LocalAdapter(where), library: where }, { mode: 'deep' })

      expect(await modelNames(IN_PLACE)).toContain('Remove Me')
    })

    it('lists what has been removed, so it can be found', async () => {
      await removeModel(db, await modelId(IN_PLACE, 'Remove Me'))

      const exclusions = await listExclusions(db, IN_PLACE)
      expect(exclusions).toHaveLength(1)
      expect(exclusions[0]!.name).toBe('Remove Me')
      expect(exclusions[0]!.libraryName).toBe('My Own Files')
    })

    it('reports nothing to restore for a path that was never removed', async () => {
      expect(await restoreExclusion(db, IN_PLACE, 'Never Existed')).toBe(false)
    })
  })

  describe('deleting the files', () => {
    it('removes them from a library the app owns', async () => {
      const where = location(MANAGED, managedRoot, 'managed')
      const result = await deleteModelFiles(
        db,
        new LocalAdapter(where),
        await modelId(MANAGED, 'Remove Me'),
      )

      expect(result.filesDeleted).toBe(1)
      expect(result.failures).toEqual([])
      expect(await readdir(path.join(managedRoot, 'Remove Me'))).toEqual([])
      expect(await modelNames(MANAGED)).toEqual(['Keep Me'])
    })

    /*
     * The promise again, enforced twice: here with an explanation, and in the
     * storage adapter with a refusal. Neither is redundant — this one is what
     * the user reads.
     */
    it('refuses outright for a library of the user\'s own files', async () => {
      const where = location(IN_PLACE, inPlaceRoot, 'in_place')
      await expect(
        deleteModelFiles(db, new LocalAdapter(where), await modelId(IN_PLACE, 'Remove Me')),
      ).rejects.toThrow(DeleteError)
    })

    it('leaves the files alone when it refuses', async () => {
      const where = location(IN_PLACE, inPlaceRoot, 'in_place')
      await deleteModelFiles(db, new LocalAdapter(where), await modelId(IN_PLACE, 'Remove Me')).catch(
        () => undefined,
      )

      expect(await readdir(path.join(inPlaceRoot, 'Remove Me'))).toEqual(['gone.stl'])
      expect(await modelNames(IN_PLACE)).toContain('Remove Me')
    })

    it('records no exclusion, because there is nothing left to find', async () => {
      const where = location(MANAGED, managedRoot, 'managed')
      await deleteModelFiles(db, new LocalAdapter(where), await modelId(MANAGED, 'Remove Me'))

      expect((await excludedPaths(db, MANAGED)).size).toBe(0)
    })

    /*
     * Dropping the row while files remain would leave orphans nothing knows
     * about, and the next scan would recreate the model without its metadata.
     */
    it('keeps the model when a file could not be deleted', async () => {
      const where = location(MANAGED, managedRoot, 'managed')
      const id = await modelId(MANAGED, 'Remove Me')

      // Remove it underneath, so the delete finds nothing to unlink.
      await rm(path.join(managedRoot, 'Remove Me', 'gone.stl'))

      const result = await deleteModelFiles(db, new LocalAdapter(where), id)

      expect(result.failures.length).toBeGreaterThan(0)
      expect(await modelNames(MANAGED)).toContain('Remove Me')
    })

    it('reports how much space it freed', async () => {
      const where = location(MANAGED, managedRoot, 'managed')
      const result = await deleteModelFiles(
        db,
        new LocalAdapter(where),
        await modelId(MANAGED, 'Remove Me'),
      )
      expect(result.bytesFreed).toBe(134)
    })
  })
})
