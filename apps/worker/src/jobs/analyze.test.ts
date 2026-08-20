import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { createDb, schema } from '@pm/db'
import { LocalAdapter, scanLibrary, type LibraryLocation } from '@pm/core'
import { handleFileDigest } from './analyze'

/**
 * Rename detection.
 *
 * A rescan sees a renamed file as one file gone and one appeared — it has no
 * other way to tell that apart from an actual edit, because at scan time
 * neither file has a content digest yet. The fold-together happens here,
 * once the digest job actually has a hash to compare, and the whole point is
 * that a genuine rename keeps its thumbnail and analysis rather than starting
 * from "pending" again.
 */
const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

const LIBRARY_ID = '4e000000-0000-4000-8000-000000000001'

describeDb('rename detection', () => {
  let pool: ReturnType<typeof createDb>['pool']
  let db: ReturnType<typeof createDb>['db']
  let base = ''
  let root = ''

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

    base = await mkdtemp(path.join(tmpdir(), 'pm-rename-'))
    root = path.join(base, 'library')
    await mkdir(path.join(root, 'Widget'), { recursive: true })
    await writeFile(path.join(root, 'Widget', 'part.stl'), stl())

    await db.execute(sql`
      INSERT INTO libraries (id, name, kind, backend, path)
      VALUES (${LIBRARY_ID}, 'Rename Verify', 'in_place', 'local', ${root})`)

    await scan()
  })

  async function cleanup() {
    await db.execute(sql`DELETE FROM libraries WHERE id = ${LIBRARY_ID}`)
  }

  function stl(): Buffer {
    const buffer = Buffer.alloc(84 + 50)
    buffer.writeUInt32LE(1, 80)
    return buffer
  }

  async function scan() {
    const location: LibraryLocation = {
      id: LIBRARY_ID,
      kind: 'in_place',
      backend: 'local',
      allowWrites: false,
      path: root,
    }
    await scanLibrary({ db, storage: new LocalAdapter(location), library: location }, { mode: 'deep' })
  }

  async function fileRow(filename: string) {
    const rows = await db
      .select()
      .from(schema.modelFiles)
      .innerJoin(schema.models, eq(schema.models.id, schema.modelFiles.modelId))
      .where(eq(schema.modelFiles.filename, filename))
    return rows[0]?.model_files
  }

  it('folds a renamed file back onto its old row, keeping the id', async () => {
    const before = await fileRow('part.stl')
    if (!before) throw new Error('fixture file missing')

    // Establish a digest, and simulate that a thumbnail and analysis already
    // ran — exactly the state a real, previously-scanned file would be in.
    await handleFileDigest({ fileId: before.id })
    await db
      .update(schema.modelFiles)
      .set({ thumbKey: 'ab/cd/deadbeefdeadbeefdeadbeefdeadbeefdead.webp', thumbState: 'ok', analysisState: 'ok' })
      .where(eq(schema.modelFiles.id, before.id))

    await rename(path.join(root, 'Widget', 'part.stl'), path.join(root, 'Widget', 'renamed.stl'))
    await scan()

    const after = await fileRow('renamed.stl')
    if (!after) throw new Error('renamed file was not indexed')

    // Still missing and pointing at the old name until the digest job runs —
    // the scan alone cannot tell a rename from an unrelated new file.
    expect(after.id).not.toBe(before.id)

    await handleFileDigest({ fileId: after.id })

    const folded = await db
      .select()
      .from(schema.modelFiles)
      .where(eq(schema.modelFiles.id, before.id))
    expect(folded[0]?.filename).toBe('renamed.stl')
    expect(folded[0]?.missingAt).toBeNull()
    expect(folded[0]?.thumbState).toBe('ok')
    expect(folded[0]?.thumbKey).toBe('ab/cd/deadbeefdeadbeefdeadbeefdeadbeefdead.webp')
    expect(folded[0]?.analysisState).toBe('ok')

    const discarded = await db
      .select()
      .from(schema.modelFiles)
      .where(eq(schema.modelFiles.id, after.id))
    expect(discarded).toHaveLength(0)

    const all = await db
      .select()
      .from(schema.modelFiles)
      .innerJoin(schema.models, eq(schema.models.id, schema.modelFiles.modelId))
      .where(eq(schema.models.libraryId, LIBRARY_ID))
    expect(all).toHaveLength(1)
  })

  it('leaves an ambiguous rename alone rather than guessing', async () => {
    // Two identical spare parts, both renamed in the same pass: whichever
    // renamed file is digested first has two equally good missing candidates
    // to fold onto, so it must fold onto neither.
    await writeFile(path.join(root, 'Widget', 'twin.stl'), stl())
    await scan()

    const original = await fileRow('part.stl')
    const twin = await fileRow('twin.stl')
    if (!original || !twin) throw new Error('fixture files missing')

    await handleFileDigest({ fileId: original.id })
    await handleFileDigest({ fileId: twin.id })

    await rename(path.join(root, 'Widget', 'part.stl'), path.join(root, 'Widget', 'part-renamed.stl'))
    await rename(path.join(root, 'Widget', 'twin.stl'), path.join(root, 'Widget', 'twin-renamed.stl'))
    await scan()

    const renamed = await fileRow('part-renamed.stl')
    if (!renamed) throw new Error('renamed file was not indexed')
    const renamedId = renamed.id

    await handleFileDigest({ fileId: renamedId })

    // Kept as its own row, not folded onto either missing candidate.
    const stillThere = await db
      .select()
      .from(schema.modelFiles)
      .where(eq(schema.modelFiles.id, renamedId))
    expect(stillThere).toHaveLength(1)

    // Both original rows are exactly as the rename left them — neither was
    // silently revived by a guess.
    const stillMissing = await db
      .select()
      .from(schema.modelFiles)
      .where(eq(schema.modelFiles.id, original.id))
    expect(stillMissing[0]?.missingAt).not.toBeNull()
  })
})
