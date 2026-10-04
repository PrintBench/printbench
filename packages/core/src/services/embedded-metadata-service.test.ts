import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { createDb, schema } from '@pb/db'
import { LocalAdapter } from '../storage/local-adapter'
import { scanLibrary } from '../scan/scan-service'
import { applyEmbeddedModelMetadata, isEmbeddedMetadataSource } from './embedded-metadata-service'
import { updateModel } from './model-service'

const describeDb = process.env.DATABASE_URL ? describe : describe.skip
const LIBRARY_ID = 'e3b00000-0000-4000-8000-000000000001'
const metadata = {
  title: 'Miniature Bread Set',
  designer: 'Embedded Metadata Test Designer',
  description: 'No supports needed. For personal use only.',
  license: 'Standard Digital File License',
  creationDate: '2026-07-02',
  modificationDate: '2026-07-03',
  sourceIdentifiers: { 'MakerWorld internal design ID': 'USopaqueinternalid' },
}

describeDb('embedded metadata persistence', () => {
  let pool: ReturnType<typeof createDb>['pool']
  let db: ReturnType<typeof createDb>['db']
  let root = ''
  let base = ''
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
    base = await mkdtemp(path.join(tmpdir(), 'pb-embedded-meta-'))
    root = path.join(base, 'library')
    await mkdir(path.join(root, '104'), { recursive: true })
    await writeFile(
      path.join(root, '104', 'a.3mf'),
      'fixture project bytes; geometry is tested separately',
    )
    await db.execute(
      sql`INSERT INTO libraries(id,name,kind,backend,path,allow_writes,write_sidecar) VALUES(${LIBRARY_ID},'Embedded Metadata Test','managed','local',${root},true,true)`,
    )
  })
  async function cleanup() {
    await db.execute(sql`DELETE FROM libraries WHERE id=${LIBRARY_ID}`)
    await db.execute(sql`DELETE FROM creators WHERE name=${metadata.designer}`)
  }
  async function scanned() {
    const location = {
      id: LIBRARY_ID,
      kind: 'managed' as const,
      backend: 'local' as const,
      allowWrites: true,
      path: root,
    }
    await scanLibrary(
      { db, storage: new LocalAdapter(location), library: location },
      { mode: 'deep' },
    )
    const models = await db
      .select()
      .from(schema.models)
      .where(eq(schema.models.libraryId, LIBRARY_ID))
    const model = models[0]!
    const files = await db
      .select()
      .from(schema.modelFiles)
      .where(eq(schema.modelFiles.modelId, model.id))
    return { model, files }
  }
  async function stored(id: string) {
    return (await db.select().from(schema.models).where(eq(schema.models.id, id)))[0]!
  }

  it('imports new metadata through creator resolution, search and a restorable sidecar', async () => {
    const { model, files } = await scanned()
    expect(model.name).toBe('104')
    expect(model.embeddedMetadataState).toBe('pending')
    expect(await applyEmbeddedModelMetadata(db, model.id, files[0]!.id, metadata)).toEqual({
      applied: true,
    })
    const row = await stored(model.id)
    expect(row.name).toBe(metadata.title)
    expect(row.license).toBe(metadata.license)
    expect(row.creatorId).toBeTruthy()
    expect(row.embeddedMetadataState).toBe('done')
    expect(row.notes).toContain('Source file creation date: 2026-07-02')
    expect(row.notes).not.toContain('USopaqueinternalid')
    expect(row.notes).not.toContain('makerworld.com')
    const search = await db.execute<{ found: boolean }>(
      sql`SELECT search_vector @@ websearch_to_tsquery('pb_search','miniature bread designer') AS found FROM models WHERE id=${model.id}`,
    )
    expect(search.rows[0]?.found).toBe(true)
    const sidecar = JSON.parse(await readFile(path.join(root, '104', '.printbench.json'), 'utf8'))
    expect(sidecar).toMatchObject({
      name: metadata.title,
      creator: metadata.designer,
      license: metadata.license,
      notes: row.notes,
    })
  })

  it('persists verified public tags and source link with metadata and sidecar', async () => {
    const { model, files } = await scanned()
    const source = {
      sourceUrl: 'https://makerworld.com/en/models/123',
      tags: ['miniatures', 'bread'],
    }
    await applyEmbeddedModelMetadata(db, model.id, files[0]!.id, metadata, source)
    const tags = await db.execute<{ name: string }>(
      sql`SELECT tags.name FROM tags JOIN model_tags ON model_tags.tag_id = tags.id WHERE model_tags.model_id = ${model.id} ORDER BY tags.name`,
    )
    expect(tags.rows.map((t) => t.name)).toEqual(['bread', 'miniatures'])
    const links = await db
      .select()
      .from(schema.modelLinks)
      .where(eq(schema.modelLinks.modelId, model.id))
    expect(links).toHaveLength(1)
    expect(links[0]?.url).toBe(source.sourceUrl)
    const sidecar = JSON.parse(await readFile(path.join(root, '104', '.printbench.json'), 'utf8'))
    expect(sidecar.tags).toEqual(expect.arrayContaining(['bread', 'miniatures']))
    expect(sidecar.links).toEqual(
      expect.arrayContaining([expect.objectContaining({ url: source.sourceUrl })]),
    )
    await updateModel(db, model.id, { tags: [], notes: 'My own notes' })
    expect(
      (await applyEmbeddedModelMetadata(db, model.id, files[0]!.id, metadata, source)).applied,
    ).toBe(false)
    expect((await stored(model.id)).notes).toBe('My own notes')
    expect(
      await db.select().from(schema.modelTags).where(eq(schema.modelTags.modelId, model.id)),
    ).toHaveLength(0)
  })

  it('preserves pending model tags supplied by another authoritative source', async () => {
    const { model, files } = await scanned()
    await updateModel(db, model.id, { tags: ['existing-tag'] })
    await db
      .update(schema.models)
      .set({ embeddedMetadataState: 'pending' })
      .where(eq(schema.models.id, model.id))
    await rm(path.join(root, '104', '.printbench.json'))
    await applyEmbeddedModelMetadata(db, model.id, files[0]!.id, metadata, {
      sourceUrl: 'https://makerworld.com/en/models/123',
      tags: ['remote-tag'],
    })
    const tags = await db.execute<{ name: string }>(
      sql`SELECT tags.name FROM tags JOIN model_tags ON model_tags.tag_id = tags.id WHERE model_tags.model_id = ${model.id}`,
    )
    expect(tags.rows.map((t) => t.name)).toEqual(['existing-tag'])
  })

  it('never refills fields deliberately cleared by an edit or replays a title', async () => {
    const { model, files } = await scanned()
    await applyEmbeddedModelMetadata(db, model.id, files[0]!.id, metadata)
    await updateModel(db, model.id, {
      name: 'My own bread title',
      notes: null,
      license: null,
      creator: null,
    })
    expect((await applyEmbeddedModelMetadata(db, model.id, files[0]!.id, metadata)).applied).toBe(
      false,
    )
    expect(await stored(model.id)).toMatchObject({
      name: 'My own bread title',
      notes: null,
      license: null,
      creatorId: null,
      embeddedMetadataState: 'done',
    })
  })

  it('preserves sidecar decisions including intentionally empty fields', async () => {
    await writeFile(
      path.join(root, '104', '.printbench.json'),
      JSON.stringify({
        version: 1,
        name: 'Curated collection title',
        notes: '',
        license: null,
        creator: null,
      }),
    )
    const { model, files } = await scanned()
    expect(model.embeddedMetadataState).toBe('done')
    expect((await applyEmbeddedModelMetadata(db, model.id, files[0]!.id, metadata)).applied).toBe(
      false,
    )
    expect(await stored(model.id)).toMatchObject({
      name: 'Curated collection title',
      notes: '',
      license: null,
      creatorId: null,
    })
  })

  it('respects a sidecar added after scanning but before the metadata job', async () => {
    const { model, files } = await scanned()
    const text = JSON.stringify({ version: 1, name: 'On-disk owner title', notes: '' })
    await writeFile(path.join(root, '104', '.printbench.json'), text)
    expect((await applyEmbeddedModelMetadata(db, model.id, files[0]!.id, metadata)).applied).toBe(
      false,
    )
    expect(await readFile(path.join(root, '104', '.printbench.json'), 'utf8')).toBe(text)
    expect((await stored(model.id)).embeddedMetadataState).toBe('done')
  })

  it('chooses the first live 3MF by filename even when jobs arrive in reverse order', async () => {
    await writeFile(path.join(root, '104', 'z-variant.3mf'), 'another fixture')
    const { model, files } = await scanned()
    const first = files.find((f) => f.filename === 'a.3mf')!
    const variant = files.find((f) => f.filename === 'z-variant.3mf')!
    expect(await isEmbeddedMetadataSource(db, model.id, first.id)).toBe(true)
    expect(await isEmbeddedMetadataSource(db, model.id, variant.id)).toBe(false)
    expect(
      (
        await applyEmbeddedModelMetadata(db, model.id, variant.id, {
          ...metadata,
          title: 'Conflicting variant',
        })
      ).applied,
    ).toBe(false)
    expect((await stored(model.id)).embeddedMetadataState).toBe('pending')
    await applyEmbeddedModelMetadata(db, model.id, first.id, metadata)
    await applyEmbeddedModelMetadata(db, model.id, variant.id, {
      ...metadata,
      title: 'Conflicting variant',
    })
    expect((await stored(model.id)).name).toBe(metadata.title)
  })

  it('atomically applies one duplicate delivery and settles metadata-free projects', async () => {
    const { model, files } = await scanned()
    const results = await Promise.all([
      applyEmbeddedModelMetadata(db, model.id, files[0]!.id, metadata),
      applyEmbeddedModelMetadata(db, model.id, files[0]!.id, metadata),
    ])
    expect(results.filter((r) => r.applied)).toHaveLength(1)
    await rm(path.join(root, '104', '.printbench.json'))
    await db
      .update(schema.models)
      .set({ embeddedMetadataState: 'pending', notes: null, license: null, creatorId: null })
      .where(eq(schema.models.id, model.id))
    expect((await applyEmbeddedModelMetadata(db, model.id, files[0]!.id, {})).applied).toBe(false)
    expect((await stored(model.id)).embeddedMetadataState).toBe('done')
  })

  it('does not replace nonempty fields or a custom name even on an eligible row', async () => {
    const { model, files } = await scanned()
    await db
      .update(schema.models)
      .set({
        name: 'Explicit imported title',
        notes: 'Imported source notes',
        license: 'Imported source license',
      })
      .where(eq(schema.models.id, model.id))
    await applyEmbeddedModelMetadata(db, model.id, files[0]!.id, metadata)
    expect(await stored(model.id)).toMatchObject({
      name: 'Explicit imported title',
      notes: 'Imported source notes',
      license: 'Imported source license',
    })
  })
})
