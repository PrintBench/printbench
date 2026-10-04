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
      license: 'Lord Phobos Commercial Seller Licence',
      licenseUrl: 'https://example.com/licence',
      licenseExpiresAt: '2026-10-31',
      commercialUse: true,
      licenseNotes: 'Attribution required. Scaling permitted.',
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
    expect(sidecarUnchanged({ name: 'X', tags: ['a', 'b'] }, { name: 'X', tags: ['b', 'a'] })).toBe(
      true,
    )
    expect(sidecarUnchanged({ name: 'X', tags: ['a'] }, { name: 'X', tags: ['a', 'b'] })).toBe(
      false,
    )
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

    it('rejects an impossible licence expiry date', () => {
      const { data, error } = parseSidecar('{"version":1,"licenseExpiresAt":"2026-02-31"}')
      expect(data).toBeNull()
      expect(error).toMatch(/expiry date/i)
    })

    it('rejects empty or whitespace-only identity fields', () => {
      expect(parseSidecar('{"version":1,"name":""}').data).toBeNull()
      expect(parseSidecar('{"version":1,"name":"   "}').data).toBeNull()
      expect(parseSidecar('{"version":1,"creator":""}').data).toBeNull()
      expect(parseSidecar('{"version":1,"creator":"   "}').data).toBeNull()
    })

    it('trims identity fields while preserving an explicit null creator', () => {
      expect(
        parseSidecar('{"version":1,"name":"  My Model  ","creator":"  The Kit Kiln  "}').data,
      ).toEqual({
        name: 'My Model',
        creator: 'The Kit Kiln',
      })

      expect(parseSidecar('{"version":1,"creator":null}').data).toEqual({
        creator: null,
      })
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

  const scan = (options: { restoreSidecars?: boolean } = {}) =>
    scanLibrary({ db, storage: new LocalAdapter(library), library }, { mode: 'deep', ...options })

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

    await db.execute(sql`
      INSERT INTO model_links (model_id, url, title, host, position)
      VALUES (
        ${id},
        'https://example.com/original-model',
        'Original model page',
        'example.com',
        0
      )
    `)

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
    expect(data?.links).toEqual([
      {
        url: 'https://example.com/original-model',
        title: 'Original model page',
      },
    ])
  })

  it('replaces model links and writes them to the sidecar', async () => {
    await scan()
    const id = await modelId('Red Dragon')

    await db.execute(sql`
      INSERT INTO model_links (model_id, url, title, host, position)
      VALUES (
        ${id},
        'https://example.com/old-link',
        'Old link',
        'example.com',
        0
      )
    `)

    const result = await updateModel(db, id, {
      links: [
        {
          title: 'Original model page',
          url: 'https://example.com/model',
        },
        {
          title: 'Assembly video',
          url: 'https://youtube.com/watch?v=test',
        },
        {
          title: 'Custom link',
          url: 'https://example.com/custom',
        },
      ],
    })

    expect(result.ok).toBe(true)
    expect(result.sidecarWritten).toBe(true)

    const links = await db.execute<{
      url: string
      title: string | null
      host: string | null
      position: number
    }>(sql`
      SELECT url, title, host, position
      FROM model_links
      WHERE model_id = ${id}
      ORDER BY position, id
    `)

    expect(links.rows).toEqual([
      {
        url: 'https://example.com/model',
        title: 'Original model page',
        host: 'example.com',
        position: 0,
      },
      {
        url: 'https://youtube.com/watch?v=test',
        title: 'Assembly video',
        host: 'youtube.com',
        position: 1,
      },
      {
        url: 'https://example.com/custom',
        title: 'Custom link',
        host: 'example.com',
        position: 2,
      },
    ])

    const written = await readFile(path.join(root, 'Red Dragon', '.printbench.json'), 'utf8')
    const { data } = parseSidecar(written)

    expect(data?.links).toEqual([
      {
        url: 'https://example.com/model',
        title: 'Original model page',
      },
      {
        url: 'https://youtube.com/watch?v=test',
        title: 'Assembly video',
      },
      {
        url: 'https://example.com/custom',
        title: 'Custom link',
      },
    ])
  })

  it('rejects more than 50 model links before changing existing links', async () => {
    await scan()
    const id = await modelId('Red Dragon')

    await db.execute(sql`
      INSERT INTO model_links (model_id, url, title, host, position)
      VALUES (${id}, 'https://example.com/existing', 'Existing', 'example.com', 0)
    `)

    const result = await updateModel(db, id, {
      links: Array.from({ length: 51 }, (_, index) => ({
        title: `Link ${index}`,
        url: `https://example.com/${index}`,
      })),
    })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/at most 50 links/i)
    expect(result.sidecarWritten).toBe(false)

    const links = await db.execute<{ url: string }>(sql`
      SELECT url FROM model_links WHERE model_id = ${id}
    `)
    expect(links.rows.map((link) => link.url)).toEqual(['https://example.com/existing'])
  })

  it('rejects model link URLs longer than the sidecar limit', async () => {
    await scan()
    const id = await modelId('Red Dragon')

    const result = await updateModel(db, id, {
      links: [{ title: 'Other', url: `https://example.com/${'x'.repeat(2000)}` }],
    })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/2000 characters/i)
    expect(result.sidecarWritten).toBe(false)
  })

  it('rejects model link titles longer than the sidecar limit', async () => {
    await scan()
    const id = await modelId('Red Dragon')

    const result = await updateModel(db, id, {
      links: [{ title: 'x'.repeat(301), url: 'https://example.com/model' }],
    })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/300 characters/i)
    expect(result.sidecarWritten).toBe(false)
  })

  it('rejects duplicate singleton model link types', async () => {
    await scan()
    const id = await modelId('Red Dragon')

    for (const title of [
      'Original model page',
      'Assembly video',
      'Printing instructions',
      'Designer page',
    ]) {
      const result = await updateModel(db, id, {
        links: [
          { title, url: 'https://example.com/one' },
          { title, url: 'https://example.com/two' },
        ],
      })

      expect(result.ok).toBe(false)
      expect(result.error).toBe(`Only one "${title}" link is allowed.`)
      expect(result.sidecarWritten).toBe(false)
    }
  })

  it('rejects an impossible licence expiry date when editing metadata', async () => {
    await scan()
    const id = await modelId('Red Dragon')

    const result = await updateModel(db, id, {
      licenseExpiresAt: '2026-02-31',
    })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/valid date/i)
    expect(result.sidecarWritten).toBe(false)

    const row = await db.execute<{ license_expires_at: string | null }>(sql`
      SELECT license_expires_at
      FROM models
      WHERE id = ${id}
    `)
    expect(row.rows[0]!.license_expires_at).toBeNull()
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

  /*
   * A sidecar is not only metadata: grouping reads it as "this folder is ONE
   * model" and collapses everything below it. Writing one into a folder that
   * has models inside it would merge them at the next scan — because someone
   * added a tag, not because they asked for a merge.
   */
  it('does not write a sidecar into a model that has models inside it', async () => {
    await mkdir(path.join(root, 'Set', 'Variant A'), { recursive: true })
    await writeFile(path.join(root, 'Set', 'base.stl'), 'z'.repeat(300))
    await writeFile(path.join(root, 'Set', 'Variant A', 'a.stl'), 'z'.repeat(200))
    await scan()

    // `deepest` grouping makes both of them models. That is the state guarded.
    const parent = await modelId('Set')
    const child = await modelId('Set/Variant A')

    const result = await updateModel(db, parent, { tags: ['pack'] })

    expect(result.ok).toBe(true)
    expect(result.sidecarWritten).toBe(false)
    await expect(readFile(path.join(root, 'Set', '.printbench.json'), 'utf8')).rejects.toThrow()

    // The edit itself still happened; only the copy on disk was withheld.
    const tags = await db.execute<{ name: string }>(sql`
      SELECT t.name FROM model_tags mt JOIN tags t ON t.id = mt.tag_id
      WHERE mt.model_id = ${parent}
    `)
    expect(tags.rows.map((r) => r.name)).toEqual(['pack'])

    // The child has nothing inside it, so it is written as normal.
    const inner = await updateModel(db, child, { tags: ['variant'] })
    expect(inner.sidecarWritten).toBe(true)
  })

  /*
   * The separator matters. Without it "Red Dragon" looks like the parent of
   * "Red Dragon Extra" and every sidecar in the library stops being written.
   */
  it('does not mistake a sibling with a longer name for a nested model', async () => {
    await mkdir(path.join(root, 'Red Dragon Extra'), { recursive: true })
    await writeFile(path.join(root, 'Red Dragon Extra', 'body.stl'), 'z'.repeat(300))
    await scan()

    const result = await updateModel(db, await modelId('Red Dragon'), { tags: ['dragon'] })
    expect(result.sidecarWritten).toBe(true)
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
      license: 'Lord Phobos Commercial Seller Licence',
      licenseUrl: 'https://example.com/licence',
      licenseExpiresAt: '2026-10-31',
      commercialUse: true,
      licenseNotes: 'Attribution required. Scaling permitted.',
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
      license_url: string
      license_expires_at: string
      commercial_use: boolean
      license_notes: string
      notes: string
      creator: string
      tags: string[]
    }>(sql`
      SELECT m.name, m.license, m.license_url, m.license_expires_at,
             m.commercial_use, m.license_notes, m.notes, c.name AS creator,
             (SELECT array_agg(t.name ORDER BY t.name) FROM model_tags mt
                JOIN tags t ON t.id = mt.tag_id WHERE mt.model_id = m.id) AS tags
      FROM models m LEFT JOIN creators c ON c.id = m.creator_id
      WHERE m.library_id = ${LIBRARY_ID} AND m.path = 'Red Dragon'
    `)

    const row = restored.rows[0]!
    expect(row.name).toBe('Red Dragon Miniature')
    expect(row.license).toBe('Lord Phobos Commercial Seller Licence')
    expect(row.license_url).toBe('https://example.com/licence')
    expect(row.license_expires_at).toBe('2026-10-31')
    expect(row.commercial_use).toBe(true)
    expect(row.license_notes).toBe('Attribution required. Scaling permitted.')
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

    const after = await db.execute<{ name: string }>(sql`SELECT name FROM models WHERE id = ${id}`)
    expect(after.rows[0]!.name).toBe('Newer Name')
  })

  it('explicitly restores sidecar metadata over an existing model', async () => {
    await scan()
    const id = await modelId('Red Dragon')

    // Give the existing database record metadata that should be replaced.
    await updateModel(db, id, {
      name: 'Database Name',
      license: 'MIT',
      licenseUrl: 'https://example.com/old-licence',
      licenseExpiresAt: '2027-12-31',
      commercialUse: true,
      licenseNotes: 'Old commercial terms',
      creator: 'Database Creator',
      tags: ['old-tag'],
      notes: 'Database notes',
    })

    // Deliberately make the sidecar authoritative. Explicit nulls and an empty
    // tag list mean those existing values should be cleared.
    await writeFile(
      path.join(root, 'Red Dragon', '.printbench.json'),
      JSON.stringify({
        version: 1,
        name: 'Sidecar Name',
        notes: null,
        license: null,
        licenseUrl: null,
        licenseExpiresAt: null,
        commercialUse: null,
        licenseNotes: null,
        creator: null,
        tags: [],
      }),
    )

    const outcome = await scan({ restoreSidecars: true })
    expect(outcome.status).toBe('succeeded')
    expect(outcome.sidecarsRestored).toBeGreaterThan(0)

    const after = await db.execute<{
      name: string
      notes: string | null
      license: string | null
      license_url: string | null
      license_expires_at: string | null
      commercial_use: boolean | null
      license_notes: string | null
      creator: string | null
      tags: string[] | null
    }>(sql`
      SELECT m.name, m.notes, m.license, m.license_url, m.license_expires_at,
             m.commercial_use, m.license_notes, c.name AS creator,
             (SELECT array_agg(t.name ORDER BY t.name) FROM model_tags mt
                JOIN tags t ON t.id = mt.tag_id WHERE mt.model_id = m.id) AS tags
      FROM models m LEFT JOIN creators c ON c.id = m.creator_id
      WHERE m.id = ${id}
    `)

    const row = after.rows[0]!
    expect(row.name).toBe('Sidecar Name')
    expect(row.notes).toBeNull()
    expect(row.license).toBeNull()
    expect(row.license_url).toBeNull()
    expect(row.license_expires_at).toBeNull()
    expect(row.commercial_use).toBeNull()
    expect(row.license_notes).toBeNull()
    expect(row.creator).toBeNull()
    expect(row.tags).toBeNull()
  })

  it('leaves existing metadata unchanged when fields are absent from the sidecar', async () => {
    await scan()
    const id = await modelId('Red Dragon')

    await updateModel(db, id, {
      name: 'Database Name',
      license: 'CC-BY-4.0',
      licenseUrl: 'https://example.com/keep-licence',
      licenseExpiresAt: '2027-06-30',
      commercialUse: false,
      licenseNotes: 'Keep these licence terms',
      creator: 'Database Creator',
      tags: ['keep-tag'],
      notes: 'Keep these notes',
    })

    // Only name is present. The other database metadata must survive.
    await writeFile(
      path.join(root, 'Red Dragon', '.printbench.json'),
      JSON.stringify({
        version: 1,
        name: 'Sidecar Name',
      }),
    )

    const outcome = await scan({ restoreSidecars: true })
    expect(outcome.status).toBe('succeeded')

    const after = await db.execute<{
      name: string
      notes: string | null
      license: string | null
      license_url: string | null
      license_expires_at: string | null
      commercial_use: boolean | null
      license_notes: string | null
      creator: string | null
      tags: string[] | null
    }>(sql`
      SELECT m.name, m.notes, m.license, m.license_url, m.license_expires_at,
             m.commercial_use, m.license_notes, c.name AS creator,
             (SELECT array_agg(t.name ORDER BY t.name) FROM model_tags mt
                JOIN tags t ON t.id = mt.tag_id WHERE mt.model_id = m.id) AS tags
      FROM models m LEFT JOIN creators c ON c.id = m.creator_id
      WHERE m.id = ${id}
    `)

    const row = after.rows[0]!
    expect(row.name).toBe('Sidecar Name')
    expect(row.notes).toBe('Keep these notes')
    expect(row.license).toBe('CC-BY-4.0')
    expect(row.license_url).toBe('https://example.com/keep-licence')
    expect(row.license_expires_at).toBe('2027-06-30')
    expect(row.commercial_use).toBe(false)
    expect(row.license_notes).toBe('Keep these licence terms')
    expect(row.creator).toBe('Database Creator')
    expect(row.tags).toEqual(['keep-tag'])
  })

  it('explicitly replaces existing links from the sidecar', async () => {
    await scan()
    const id = await modelId('Red Dragon')

    await db.execute(sql`
      INSERT INTO model_links (model_id, url, title, host, position)
      VALUES
        (${id}, 'https://old.example.com/model', 'Old link', 'old.example.com', 0),
        (${id}, 'https://remove.example.com/model', 'Remove me', 'remove.example.com', 1)
    `)

    await writeFile(
      path.join(root, 'Red Dragon', '.printbench.json'),
      JSON.stringify({
        version: 1,
        links: [
          {
            url: 'https://example.com/red-dragon',
            title: 'Red Dragon',
          },
          {
            url: 'not-a-valid-url',
            title: 'Custom link',
          },
        ],
      }),
    )

    const outcome = await scan({ restoreSidecars: true })
    expect(outcome.status).toBe('succeeded')

    const after = await db.execute<{
      url: string
      title: string | null
      host: string | null
      position: number
    }>(sql`
      SELECT url, title, host, position
      FROM model_links
      WHERE model_id = ${id}
      ORDER BY position
    `)

    expect(after.rows).toEqual([
      {
        url: 'https://example.com/red-dragon',
        title: 'Red Dragon',
        host: 'example.com',
        position: 0,
      },
      {
        url: 'not-a-valid-url',
        title: 'Custom link',
        host: null,
        position: 1,
      },
    ])
  })

  it('explicitly clears existing links when the sidecar contains an empty link list', async () => {
    await scan()
    const id = await modelId('Red Dragon')

    await db.execute(sql`
      INSERT INTO model_links (model_id, url, title, host, position)
      VALUES (${id}, 'https://old.example.com/model', 'Old link', 'old.example.com', 0)
    `)

    await writeFile(
      path.join(root, 'Red Dragon', '.printbench.json'),
      JSON.stringify({
        version: 1,
        links: [],
      }),
    )

    await scan({ restoreSidecars: true })

    const after = await db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count
      FROM model_links
      WHERE model_id = ${id}
    `)

    expect(after.rows[0]!.count).toBe(0)
  })

  it('leaves existing links unchanged when links are absent from the sidecar', async () => {
    await scan()
    const id = await modelId('Red Dragon')

    await db.execute(sql`
      INSERT INTO model_links (model_id, url, title, host, position)
      VALUES (${id}, 'https://keep.example.com/model', 'Keep me', 'keep.example.com', 0)
    `)

    await writeFile(
      path.join(root, 'Red Dragon', '.printbench.json'),
      JSON.stringify({
        version: 1,
        name: 'Sidecar Name',
      }),
    )

    await scan({ restoreSidecars: true })

    const after = await db.execute<{
      url: string
      title: string | null
      host: string | null
    }>(sql`
      SELECT url, title, host
      FROM model_links
      WHERE model_id = ${id}
    `)

    expect(after.rows).toEqual([
      {
        url: 'https://keep.example.com/model',
        title: 'Keep me',
        host: 'keep.example.com',
      },
    ])
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
