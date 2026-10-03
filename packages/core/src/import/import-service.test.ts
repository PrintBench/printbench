import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { eq, inArray } from 'drizzle-orm'
import { LocalAdapter } from '../storage/local-adapter'
import { scanLibrary } from '../scan/scan-service'
import {
  applyEmbeddedModelMetadata,
  isEmbeddedMetadataSource,
} from '../services/embedded-metadata-service'
import { createDb, schema } from '@pb/db'
import { decryptSecret } from '../security/secret-box'
import { searchModels } from '../search/search-service'
import { updateModel } from '../services/model-service'
import {
  createMakerWorldImport,
  createModelSourceImport,
  getMakerWorldCookieStatus,
  getMakerWorldImportStatus,
  getThingiverseTokenStatus,
  markMakerWorldImportQueueFailed,
  processMakerWorldImport,
  saveMakerWorldCookie,
  saveThingiverseToken,
  type MakerWorldImportDependencies,
} from './import-service'
import type { MakerWorldModel } from './makerworld'
import type { ExternalSourceModel, SourceFileFormat } from './source-provider-types'

const describeDb = process.env.DATABASE_URL ? describe : describe.skip
const sourceUrl = 'https://makerworld.com/en/models/123'
const token = 'synthetic.own-session.value'
const thingiverseToken = 'synthetic-own-thingiverse-token'
const printablesUrl = 'https://www.printables.com/model/123'
const thingiverseUrl = 'https://www.thingiverse.com/thing:123'
const stlBytes = Buffer.from(`solid fixture
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 1 0 0
vertex 0 1 0
endloop
endfacet
endsolid fixture
`)
// Independently generated ZIP containing a three-vertex 3MF triangle. The
// worker validates downloads; this service test exercises storage and indexing.
const modelBytes = Buffer.from(
  'UEsDBBQAAAAIAEVfQl3WmDDoxwAAAGwBAAAQAAAAM0QvM2Rtb2RlbC5tb2RlbHWPXY7DIAyEr4I4QB1S7csKuEtK3MYrfiowUdrTbwIrNS/7Yo30zdgeHdKMXmzBx2Lkwvz8BihuwTCVSyCXU0l3vrgU4DqHKdb75Lhmig9wKSOMg/qCYZSiRmIjA3lPARmztDpjSTU7LFan2w86FjQbqaTg1xN373F5twUsi9UrZqbmPRRuYjNykOLV5vuYcEbqf9RT6oPgs5szTfHhz1KsqmXWsYXWq5FjS5280H+EXmMXp2q3Sn62mhiD6Ly3PFb8MWhV7S9QSwECFAMUAAAACABFX0Jd1pgw6McAAABsAQAAEAAAAAAAAAAAAAAAgAEAAAAAM0QvM2Rtb2RlbC5tb2RlbFBLBQYAAAAAAQABAD4AAAD1AAAAAAA=',
  'base64',
)

describeDb('model source import service', () => {
  let db: ReturnType<typeof createDb>['db']
  let pool: ReturnType<typeof createDb>['pool']
  let root: string
  let libraryId: string
  let memberId: string
  let otherId: string
  let viewerId: string
  let fixture: MakerWorldModel

  beforeAll(() => {
    ;({ db, pool } = createDb())
    vi.stubEnv('BETTER_AUTH_SECRET', 'makerworld-import-service-test-encryption-secret')
  })
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'pb-makerworld-import-'))
    libraryId = randomUUID()
    memberId = `mw-member-${randomUUID()}`
    otherId = `mw-other-${randomUUID()}`
    viewerId = `mw-viewer-${randomUUID()}`
    await db.insert(schema.user).values([
      {
        id: memberId,
        name: 'Import member',
        email: `${memberId}@example.test`,
        emailVerified: true,
        role: 'member',
      },
      {
        id: otherId,
        name: 'Other member',
        email: `${otherId}@example.test`,
        emailVerified: true,
        role: 'member',
      },
      {
        id: viewerId,
        name: 'Viewer',
        email: `${viewerId}@example.test`,
        emailVerified: true,
        role: 'viewer',
      },
    ])
    await db.insert(schema.libraries).values({
      id: libraryId,
      name: 'Import fixture',
      kind: 'managed',
      backend: 'local',
      path: root,
    })
    fixture = {
      sourceUrl,
      externalId: '123',
      title: 'Adjustable workshop bracket',
      description: 'Independently written calibration description.',
      license: 'CC-BY-4.0',
      creator: { name: `Import maker ${libraryId}`, url: 'https://makerworld.com/en/@example' },
      tags: [`import-fixture-${libraryId}`],
      thumbnailUrl: null,
      profiles: [{ id: '456', title: 'Standard' }],
      files: [
        {
          profileId: '456',
          filename: 'bracket.3mf',
          url: 'https://makerworld.bblmw.com/bracket.3mf',
        },
      ],
    }
  })
  afterEach(async () => {
    await db.delete(schema.libraries).where(eq(schema.libraries.id, libraryId))
    await db.delete(schema.user).where(inArray(schema.user.id, [memberId, otherId, viewerId]))
    await db.delete(schema.creators).where(eq(schema.creators.name, fixture.creator!.name))
    await db.delete(schema.tags).where(eq(schema.tags.name, fixture.tags[0]!))
    await rm(root, { recursive: true, force: true })
  })
  afterAll(async () => {
    vi.unstubAllEnvs()
    await pool.end()
  })

  const credentials = () => saveMakerWorldCookie(db, memberId, `other=ignored; token=${token}`)
  async function queued(url = sourceUrl) {
    await credentials()
    return createMakerWorldImport(db, { userId: memberId, libraryId, url })
  }
  function dependencies(model: MakerWorldModel | ExternalSourceModel = fixture) {
    return {
      fetchModel: vi.fn<MakerWorldImportDependencies['fetchModel']>(async () => model),
      download: vi.fn<MakerWorldImportDependencies['download']>(async () =>
        Readable.from([modelBytes]),
      ),
      onDerivedWork: vi.fn(async (_ids: string[]) => undefined),
    } satisfies MakerWorldImportDependencies
  }
  function sourceFixture(provider: 'printables' | 'thingiverse'): ExternalSourceModel {
    return {
      ...fixture,
      sourceUrl: provider === 'printables' ? printablesUrl : thingiverseUrl,
      title: `${provider} workshop bracket`,
      files: [
        {
          id: '789',
          filename: 'bracket.stl',
          format: 'stl',
          url:
            provider === 'printables'
              ? 'https://files.printables.com/bracket.stl'
              : 'https://cdn.thingiverse.com/bracket.stl',
        },
      ],
    }
  }
  async function job(id: string) {
    return (await db.select().from(schema.modelImports).where(eq(schema.modelImports.id, id)))[0]!
  }
  async function filesOnDisk() {
    return (await readdir(root, { recursive: true, withFileTypes: true })).filter((entry) =>
      entry.isFile(),
    )
  }

  it('encrypts only the owning user token, exposes status only, and removes it on disconnect', async () => {
    expect(await getMakerWorldCookieStatus(db, memberId)).toBe(false)
    await credentials()
    const [stored] = await db
      .select()
      .from(schema.providerCredentials)
      .where(eq(schema.providerCredentials.userId, memberId))
    expect(stored!.makerWorldCookieEncrypted).not.toContain(token)
    expect(decryptSecret(stored!.makerWorldCookieEncrypted)).toBe(token)
    expect(await getMakerWorldCookieStatus(db, memberId)).toBe(true)
    expect(await getMakerWorldCookieStatus(db, otherId)).toBe(false)
    await saveMakerWorldCookie(db, memberId, '')
    expect(await getMakerWorldCookieStatus(db, memberId)).toBe(false)
    expect(
      await db
        .select()
        .from(schema.providerCredentials)
        .where(eq(schema.providerCredentials.userId, memberId)),
    ).toHaveLength(0)
  })

  it('rejects viewer or banned-user credential edits and malformed credentials', async () => {
    await expect(saveMakerWorldCookie(db, viewerId, token)).rejects.toThrow()
    await db.update(schema.user).set({ banned: true }).where(eq(schema.user.id, memberId))
    await expect(saveMakerWorldCookie(db, memberId, token)).rejects.toThrow()
    await expect(
      saveMakerWorldCookie(db, otherId, 'token=private\r\nHeader: value'),
    ).rejects.toThrow('Paste the MakerWorld')
  })

  it('encrypts Thingiverse tokens per user and keeps each provider on independent disconnects', async () => {
    expect(await getThingiverseTokenStatus(db, memberId)).toBe(false)
    await credentials()
    await saveThingiverseToken(db, memberId, `Bearer ${thingiverseToken}`)
    const [stored] = await db
      .select()
      .from(schema.providerCredentials)
      .where(eq(schema.providerCredentials.userId, memberId))
    expect(stored!.thingiverseTokenEncrypted).not.toContain(thingiverseToken)
    expect(decryptSecret(stored!.thingiverseTokenEncrypted)).toBe(thingiverseToken)
    expect(decryptSecret(stored!.makerWorldCookieEncrypted)).toBe(token)
    expect(await getThingiverseTokenStatus(db, memberId)).toBe(true)
    expect(await getThingiverseTokenStatus(db, otherId)).toBe(false)

    await saveThingiverseToken(db, memberId, '')
    expect(await getThingiverseTokenStatus(db, memberId)).toBe(false)
    expect(await getMakerWorldCookieStatus(db, memberId)).toBe(true)
    await saveThingiverseToken(db, memberId, thingiverseToken)
    await saveMakerWorldCookie(db, memberId, '')
    expect(await getMakerWorldCookieStatus(db, memberId)).toBe(false)
    expect(await getThingiverseTokenStatus(db, memberId)).toBe(true)
    await saveThingiverseToken(db, memberId, '')
    expect(
      await db
        .select()
        .from(schema.providerCredentials)
        .where(eq(schema.providerCredentials.userId, memberId)),
    ).toHaveLength(0)
  })

  it('authorizes Thingiverse credential reads and edits and rejects malformed tokens', async () => {
    await expect(saveThingiverseToken(db, viewerId, thingiverseToken)).rejects.toThrow()
    await expect(getThingiverseTokenStatus(db, viewerId)).rejects.toThrow()
    await db.update(schema.user).set({ banned: true }).where(eq(schema.user.id, memberId))
    await expect(saveThingiverseToken(db, memberId, thingiverseToken)).rejects.toThrow()
    await expect(saveThingiverseToken(db, otherId, 'private\r\nHeader: value')).rejects.toThrow(
      'Thingiverse API token',
    )
    expect(
      await db
        .select()
        .from(schema.providerCredentials)
        .where(eq(schema.providerCredentials.userId, viewerId)),
    ).toHaveLength(0)
  })

  it('imports a public Printables STL without credentials and stores its metadata, tags and source', async () => {
    const { id } = await createModelSourceImport(db, {
      userId: memberId,
      libraryId,
      url: printablesUrl,
    })
    const external = sourceFixture('printables')
    const deps = dependencies(external)
    deps.download.mockResolvedValue(Readable.from([stlBytes]))
    await processMakerWorldImport(db, id, deps)
    const imported = await job(id)
    expect(imported.state).toBe('complete')
    const [model] = await db
      .select()
      .from(schema.models)
      .where(eq(schema.models.id, imported.modelId!))
    expect(model).toMatchObject({
      name: external.title,
      notes: external.description,
      license: external.license,
    })
    const tags = await db
      .select({ name: schema.tags.name })
      .from(schema.modelTags)
      .innerJoin(schema.tags, eq(schema.tags.id, schema.modelTags.tagId))
      .where(eq(schema.modelTags.modelId, model!.id))
    expect(tags.map((tag) => tag.name)).toEqual(external.tags)
    expect(
      await db.select().from(schema.modelLinks).where(eq(schema.modelLinks.modelId, model!.id)),
    ).toMatchObject([{ url: printablesUrl, host: 'www.printables.com' }])
    expect(await readFile(path.join(root, model!.path, '789-bracket.stl'))).toEqual(stlBytes)
    expect(deps.fetchModel).toHaveBeenCalledWith(printablesUrl, '')
    expect(deps.download).toHaveBeenCalledWith(external.files[0]!.url, 'stl', {
      provider: 'printables',
      token: '',
    })
    expect(deps.onDerivedWork).toHaveBeenCalled()
    expect(await getMakerWorldCookieStatus(db, memberId)).toBe(false)
  })

  it('requires the owning Thingiverse token and never substitutes another user or MakerWorld credential', async () => {
    await credentials()
    await saveThingiverseToken(db, otherId, 'other-users-thingiverse-token')
    await expect(
      createModelSourceImport(db, { userId: memberId, libraryId, url: thingiverseUrl }),
    ).rejects.toThrow('Thingiverse API token')
    await saveThingiverseToken(db, memberId, thingiverseToken)
    const { id } = await createModelSourceImport(db, {
      userId: memberId,
      libraryId,
      url: thingiverseUrl,
    })
    const external = sourceFixture('thingiverse')
    const deps = dependencies(external)
    deps.download.mockResolvedValue(Readable.from([stlBytes]))
    await processMakerWorldImport(db, id, deps)
    expect((await job(id)).state).toBe('complete')
    expect(deps.fetchModel).toHaveBeenCalledWith(thingiverseUrl, thingiverseToken)
    expect(deps.download).toHaveBeenCalledWith(external.files[0]!.url, 'stl', {
      provider: 'thingiverse',
      token: thingiverseToken,
    })
    expect((await job(id)).error).toBeNull()
  })

  it('rechecks Thingiverse disconnect before a queued import starts', async () => {
    await saveThingiverseToken(db, memberId, thingiverseToken)
    const { id } = await createModelSourceImport(db, {
      userId: memberId,
      libraryId,
      url: thingiverseUrl,
    })
    await saveThingiverseToken(db, memberId, '')
    const deps = dependencies(sourceFixture('thingiverse'))
    await processMakerWorldImport(db, id, deps)
    expect((await job(id)).state).toBe('failed')
    expect(deps.fetchModel).not.toHaveBeenCalled()
    expect(deps.download).not.toHaveBeenCalled()
  })

  it.each(['provider', 'externalId', 'sourceUrl'] as const)(
    'rejects provider responses with mismatched %s identity before storing files',
    async (mismatch) => {
      const { id } = await createModelSourceImport(db, {
        userId: memberId,
        libraryId,
        url: printablesUrl,
      })
      const external = sourceFixture('printables')
      if (mismatch === 'provider') external.sourceUrl = thingiverseUrl
      if (mismatch === 'externalId') external.externalId = '999'
      if (mismatch === 'sourceUrl') external.sourceUrl = 'https://www.printables.com/model/999'
      const deps = dependencies(external)
      await processMakerWorldImport(db, id, deps)
      expect((await job(id)).state).toBe('failed')
      expect(deps.download).not.toHaveBeenCalled()
      expect(await filesOnDisk()).toHaveLength(0)
      expect(
        await db.select().from(schema.models).where(eq(schema.models.libraryId, libraryId)),
      ).toHaveLength(0)
    },
  )

  it('requires own credentials and rejects invalid model URLs and read-only storage', async () => {
    await expect(
      createMakerWorldImport(db, { userId: memberId, libraryId, url: sourceUrl }),
    ).rejects.toThrow('cookie')
    await credentials()
    await expect(
      createMakerWorldImport(db, {
        userId: memberId,
        libraryId,
        url: 'https://makerworld.com.evil.test/models/123',
      }),
    ).rejects.toThrow('model-page URL')
    await db
      .update(schema.libraries)
      .set({ kind: 'in_place', allowWrites: false })
      .where(eq(schema.libraries.id, libraryId))
    await expect(
      createMakerWorldImport(db, { userId: memberId, libraryId, url: sourceUrl }),
    ).rejects.toThrow('read-only')
    expect(
      await db
        .select()
        .from(schema.modelImports)
        .where(eq(schema.modelImports.libraryId, libraryId)),
    ).toHaveLength(0)
  })

  it('rejects disabled scans, invalid library IDs, and viewers before enqueue', async () => {
    await credentials()
    await expect(
      createMakerWorldImport(db, { userId: viewerId, libraryId, url: sourceUrl }),
    ).rejects.toThrow()
    await expect(
      createMakerWorldImport(db, { userId: memberId, libraryId: 'bad', url: sourceUrl }),
    ).rejects.toThrow('writable library')
    await db
      .update(schema.libraries)
      .set({ scanEnabled: false })
      .where(eq(schema.libraries.id, libraryId))
    await expect(
      createMakerWorldImport(db, { userId: memberId, libraryId, url: sourceUrl }),
    ).rejects.toThrow('scanning enabled')
  })

  it('deduplicates URL aliases and hides another user request status', async () => {
    const first = await queued('https://makerworld.com/en/models/123-a-title?tracking=ignored')
    const second = await createMakerWorldImport(db, {
      userId: memberId,
      libraryId,
      url: 'https://makerworld.com/models/123',
    })
    expect(second.id).toBe(first.id)
    expect(await getMakerWorldImportStatus(db, otherId, first.id)).toBeNull()
    expect(await getMakerWorldImportStatus(db, memberId, first.id)).toMatchObject({
      state: 'queued',
      error: null,
    })
    await saveMakerWorldCookie(db, otherId, 'other-own-token')
    await expect(
      createMakerWorldImport(db, { userId: otherId, libraryId, url: sourceUrl }),
    ).rejects.toThrow('already being imported')
  })

  it('stores provider metadata, source, bytes, search data and sidecar before derived work', async () => {
    const { id } = await queued()
    const deps = dependencies()
    await processMakerWorldImport(db, id, deps)
    const imported = await job(id)
    expect(imported).toMatchObject({ state: 'complete', error: null })
    expect(imported.modelId).toBeTruthy()
    const [model] = await db
      .select()
      .from(schema.models)
      .where(eq(schema.models.id, imported.modelId!))
    expect(model).toMatchObject({
      name: fixture.title,
      notes: fixture.description,
      license: fixture.license,
      embeddedMetadataState: 'done',
    })
    const [creator] = await db
      .select()
      .from(schema.creators)
      .where(eq(schema.creators.id, model!.creatorId!))
    expect(creator?.name).toBe(fixture.creator!.name)
    const tags = await db
      .select({ name: schema.tags.name })
      .from(schema.modelTags)
      .innerJoin(schema.tags, eq(schema.tags.id, schema.modelTags.tagId))
      .where(eq(schema.modelTags.modelId, model!.id))
    expect(tags.map((tag) => tag.name)).toEqual(fixture.tags)
    expect(
      await db.select().from(schema.modelLinks).where(eq(schema.modelLinks.modelId, model!.id)),
    ).toMatchObject([{ url: sourceUrl, host: 'makerworld.com' }])
    const files = await db
      .select()
      .from(schema.modelFiles)
      .where(eq(schema.modelFiles.modelId, model!.id))
    expect(files).toHaveLength(1)
    expect(await readFile(path.join(root, model!.path, 'profile-456.3mf'))).toEqual(modelBytes)
    expect(
      JSON.parse(await readFile(path.join(root, model!.path, '.printbench.json'), 'utf8')),
    ).toMatchObject({ name: fixture.title, notes: fixture.description })
    expect(
      (await searchModels(db, { query: 'Adjustable', libraryIds: [libraryId] })).hits.map(
        (hit) => hit.id,
      ),
    ).toContain(model!.id)
    expect(deps.fetchModel).toHaveBeenCalledWith(sourceUrl, token)
    expect(deps.onDerivedWork).toHaveBeenCalledWith(expect.arrayContaining([files[0]!.id]))
    expect(await getMakerWorldImportStatus(db, memberId, id)).toMatchObject({
      state: 'complete',
      publicId: model!.publicId,
    })
  })

  it('does not download again or overwrite edits on repeated completed delivery', async () => {
    const { id } = await queued()
    const deps = dependencies()
    await processMakerWorldImport(db, id, deps)
    const completed = await job(id)
    expect(completed.state).toBe('complete')
    await updateModel(db, completed.modelId!, { name: 'My chosen name' })
    expect(
      (await createMakerWorldImport(db, { userId: memberId, libraryId, url: sourceUrl })).id,
    ).toBe(id)
    await processMakerWorldImport(db, id, deps)
    expect(deps.fetchModel).toHaveBeenCalledTimes(1)
    expect(deps.download).toHaveBeenCalledTimes(1)
    const models = await db
      .select()
      .from(schema.models)
      .where(eq(schema.models.libraryId, libraryId))
    expect(models).toHaveLength(1)
    expect(models[0]?.name).toBe('My chosen name')
  })

  it('rolls back newly published files if a scan aborts before reserving the imported model', async () => {
    const { id } = await queued()
    await db.insert(schema.models).values(
      Array.from({ length: 5 }, (_, index) => ({
        libraryId,
        path: `Unavailable-${index}`,
        name: `Unavailable ${index}`,
        slug: `unavailable-${index}`,
        publicId: `gone-${randomUUID()}`,
      })),
    )
    await processMakerWorldImport(db, id, dependencies())
    expect(await job(id)).toMatchObject({ state: 'failed', modelId: null })
    expect(await filesOnDisk()).toHaveLength(0)
    const location = {
      id: libraryId,
      kind: 'managed' as const,
      backend: 'local' as const,
      path: root,
      allowWrites: true,
    }
    expect(
      (
        await scanLibrary(
          { db, storage: new LocalAdapter(location), library: location },
          { force: true },
        )
      ).status,
    ).toBe('succeeded')
  })

  it('reserves source metadata while a normal scan overlaps publication of a metadata-free 3MF', async () => {
    const { id } = await queued()
    const deps = dependencies()
    const location = {
      id: libraryId,
      kind: 'managed' as const,
      backend: 'local' as const,
      path: root,
      allowWrites: true,
    }
    const storage = new LocalAdapter(location)
    const health = vi.spyOn(storage, 'healthCheck')
    let metadataEntered!: () => void
    let releaseMetadata!: () => void
    let scanAttempted!: () => void
    const metadataStarted = new Promise<void>((resolve) => {
      metadataEntered = resolve
    })
    const held = new Promise<void>((resolve) => {
      releaseMetadata = resolve
    })
    const scanWaiting = new Promise<void>((resolve) => {
      scanAttempted = resolve
    })
    const originalTransaction = db.transaction.bind(db)
    let count = 0
    const transaction = vi.spyOn(db, 'transaction').mockImplementation((callback, config) =>
      originalTransaction(async (tx) => {
        const execute = tx.execute.bind(tx)
        tx.execute = ((query: Parameters<typeof tx.execute>[0]) =>
          execute(query).then((result) => {
            if ((result.rows[0] as { acquired?: boolean } | undefined)?.acquired === false)
              scanAttempted()
            return result
          })) as typeof tx.execute
        // Import-id lease, library lease, atomic model reservation, then metadata.
        if (++count === 4) {
          metadataEntered()
          await held
        }
        return callback(tx)
      }, config),
    )
    const importing = processMakerWorldImport(db, id, deps)
    let scanning: ReturnType<typeof scanLibrary> | undefined
    try {
      await metadataStarted
      const reserved = await job(id)
      expect(reserved).toMatchObject({ state: 'importing' })
      expect(reserved.modelId).not.toBeNull()
      const [file] = await db
        .select()
        .from(schema.modelFiles)
        .where(eq(schema.modelFiles.modelId, reserved.modelId!))
      expect(await isEmbeddedMetadataSource(db, reserved.modelId!, file!.id)).toBe(false)
      // An already delivered analysis job must not turn an empty metadata
      // result into authority and prevent the provider's description from saving.
      expect(await applyEmbeddedModelMetadata(db, reserved.modelId!, file!.id, {})).toMatchObject({
        applied: false,
        reason: 'Source import metadata is reserved.',
      })
      scanning = scanLibrary(
        { db, storage, library: location },
        {
          onDerivedWork: async (ids) => {
            for (const fileId of ids)
              await applyEmbeddedModelMetadata(db, reserved.modelId!, fileId, {})
          },
        },
      )
      await scanWaiting
      expect(health).not.toHaveBeenCalled()
      releaseMetadata()
      await importing
      expect((await scanning).status).toBe('succeeded')
      const completed = await job(id)
      expect(completed).toMatchObject({ state: 'complete', modelId: reserved.modelId, error: null })
      const models = await db
        .select()
        .from(schema.models)
        .where(eq(schema.models.libraryId, libraryId))
      expect(models).toHaveLength(1)
      expect(models[0]).toMatchObject({
        name: fixture.title,
        notes: fixture.description,
        license: fixture.license,
        embeddedMetadataState: 'done',
      })
      const [creator] = await db
        .select()
        .from(schema.creators)
        .where(eq(schema.creators.id, models[0]!.creatorId!))
      expect(creator?.name).toBe(fixture.creator!.name)
      const tags = await db
        .select({ name: schema.tags.name })
        .from(schema.modelTags)
        .innerJoin(schema.tags, eq(schema.tags.id, schema.modelTags.tagId))
        .where(eq(schema.modelTags.modelId, reserved.modelId!))
      expect(tags.map((tag) => tag.name)).toEqual(fixture.tags)
      expect(
        (
          await db
            .select()
            .from(schema.modelLinks)
            .where(eq(schema.modelLinks.modelId, reserved.modelId!))
        )[0]?.url,
      ).toBe(sourceUrl)
      expect(
        await db
          .select()
          .from(schema.modelFiles)
          .where(eq(schema.modelFiles.modelId, reserved.modelId!)),
      ).toHaveLength(1)
      expect(await readFile(path.join(root, models[0]!.path, 'profile-456.3mf'))).toEqual(
        modelBytes,
      )
    } finally {
      releaseMetadata()
      await importing
      await scanning
      transaction.mockRestore()
      health.mockRestore()
    }
  })

  it('keeps progress visible while a concurrent duplicate delivery exits without downloading', async () => {
    const { id } = await queued()
    const deps = dependencies()
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    deps.fetchModel.mockImplementation(async () => {
      entered()
      await held
      return fixture
    })
    const first = processMakerWorldImport(db, id, deps)
    let second: Promise<void> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        started,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('First delivery did not reach provider')), 3000)
        }),
      ])
      clearTimeout(timer)
      expect(await getMakerWorldImportStatus(db, memberId, id)).toMatchObject({
        state: 'importing',
      })
      second = processMakerWorldImport(db, id, deps)
      await Promise.race([
        second,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Duplicate delivery blocked instead of exiting')),
            3000,
          )
        }),
      ])
      expect(deps.fetchModel).toHaveBeenCalledTimes(1)
      expect(deps.download).not.toHaveBeenCalled()
      expect((await job(id)).state).toBe('importing')
    } finally {
      clearTimeout(timer)
      release()
      await Promise.all([first, ...(second ? [second] : [])])
    }
    expect((await job(id)).state).toBe('complete')
    expect(deps.download).toHaveBeenCalledTimes(1)
    expect(
      await db.select().from(schema.models).where(eq(schema.models.libraryId, libraryId)),
    ).toHaveLength(1)
  }, 10_000)

  it.each(['top_level', 'flat'] as const)(
    'imports its first-level folder while respecting existing %s grouping',
    async (groupingMode) => {
      await db
        .update(schema.libraries)
        .set({ groupingMode })
        .where(eq(schema.libraries.id, libraryId))
      // Files at both parent and child make this grouping ambiguous. top_level
      // collapses that case (pure containers still recurse); flat at depth one
      // also groups it at the parent, unlike deepest's separate child model.
      await mkdir(path.join(root, 'existing', 'nested'), { recursive: true })
      await writeFile(path.join(root, 'existing', 'root.3mf'), modelBytes)
      await writeFile(path.join(root, 'existing', 'nested', 'old.3mf'), modelBytes)
      const { id } = await queued()
      await processMakerWorldImport(db, id, dependencies())
      expect((await job(id)).state).toBe('complete')
      const models = await db
        .select()
        .from(schema.models)
        .where(eq(schema.models.libraryId, libraryId))
      expect(models.map((model) => model.path).sort()).toEqual(['existing', `makerworld-123-${id}`])
      expect(await readFile(path.join(root, 'existing', 'nested', 'old.3mf'))).toEqual(modelBytes)
    },
  )

  it('treats missing remote artwork as optional', async () => {
    const { id } = await queued()
    const deps = dependencies({
      ...fixture,
      thumbnailUrl: 'https://makerworld.bblmw.com/cover.webp',
    })
    deps.download.mockImplementation(async (_url: string, kind: SourceFileFormat | 'image') => {
      if (kind === 'image') throw new Error('artwork unavailable')
      return Readable.from([modelBytes])
    })
    await processMakerWorldImport(db, id, deps)
    expect((await job(id)).state).toBe('complete')
    expect((await filesOnDisk()).some((entry) => entry.name.endsWith('.webp'))).toBe(false)
  })

  it('saves optional artwork beside the profile', async () => {
    const { id } = await queued()
    const deps = dependencies({
      ...fixture,
      thumbnailUrl: 'https://makerworld.bblmw.com/cover.webp',
    })
    const artwork = Buffer.from('synthetic image bytes; worker decoder is mocked')
    deps.download.mockImplementation(async (_url: string, kind: SourceFileFormat | 'image') =>
      Readable.from([kind === 'image' ? artwork : modelBytes]),
    )
    await processMakerWorldImport(db, id, deps)
    expect((await job(id)).state).toBe('complete')
    expect(await readFile(path.join(root, `makerworld-123-${id}`, 'cover.webp'))).toEqual(artwork)
  })

  it.each(['credentials', 'banned', 'viewer', 'read-only'] as const)(
    'rechecks %s after queueing and before using provider credentials',
    async (change) => {
      const { id } = await queued()
      if (change === 'credentials') await saveMakerWorldCookie(db, memberId, '')
      if (change === 'banned')
        await db.update(schema.user).set({ banned: true }).where(eq(schema.user.id, memberId))
      if (change === 'viewer')
        await db.update(schema.user).set({ role: 'viewer' }).where(eq(schema.user.id, memberId))
      if (change === 'read-only')
        await db
          .update(schema.libraries)
          .set({ kind: 'in_place', allowWrites: false })
          .where(eq(schema.libraries.id, libraryId))
      const deps = dependencies()
      await processMakerWorldImport(db, id, deps)
      expect((await job(id)).state).toBe('failed')
      expect(deps.fetchModel).not.toHaveBeenCalled()
      expect(deps.download).not.toHaveBeenCalled()
      expect(await filesOnDisk()).toHaveLength(0)
    },
  )

  it('sanitizes arbitrary provider errors and permits deliberate retry', async () => {
    const { id } = await queued()
    const deps = dependencies()
    deps.fetchModel.mockRejectedValueOnce(
      new Error(`credential=${token}; signedURL=https://example.test/?secret=value`),
    )
    await processMakerWorldImport(db, id, deps)
    const failed = await job(id)
    expect(failed.state).toBe('failed')
    expect(failed.error).not.toMatch(/synthetic|signedURL|secret=value/)
    expect(failed.error).toContain('Import failed')
    expect(
      (await createMakerWorldImport(db, { userId: memberId, libraryId, url: sourceUrl })).id,
    ).toBe(id)
    expect((await job(id)).state).toBe('queued')
    await processMakerWorldImport(db, id, deps)
    expect((await job(id)).state).toBe('complete')
  })

  it('requeues derived work after callback failure without downloading again or replacing edits', async () => {
    const { id } = await queued()
    const deps = dependencies()
    deps.onDerivedWork.mockRejectedValueOnce(new Error('temporary queue failure'))
    await processMakerWorldImport(db, id, deps)
    expect((await job(id)).state).toBe('failed')
    const [model] = await db
      .select()
      .from(schema.models)
      .where(eq(schema.models.libraryId, libraryId))
    expect(model).toBeDefined()
    const files = await db
      .select()
      .from(schema.modelFiles)
      .where(eq(schema.modelFiles.modelId, model!.id))
    expect(files).toHaveLength(1)
    const fileId = files[0]!.id
    await updateModel(db, model!.id, { name: 'My revised bracket name' })

    expect(
      (await createMakerWorldImport(db, { userId: memberId, libraryId, url: sourceUrl })).id,
    ).toBe(id)
    await processMakerWorldImport(db, id, deps)
    expect((await job(id)).state).toBe('complete')
    expect(deps.download).toHaveBeenCalledTimes(1)
    expect(deps.onDerivedWork).toHaveBeenNthCalledWith(1, expect.arrayContaining([fileId]))
    expect(deps.onDerivedWork).toHaveBeenNthCalledWith(2, expect.arrayContaining([fileId]))
    const [after] = await db.select().from(schema.models).where(eq(schema.models.id, model!.id))
    expect(after?.name).toBe('My revised bracket name')
    const links = await db
      .select()
      .from(schema.modelLinks)
      .where(eq(schema.modelLinks.modelId, model!.id))
    expect(links).toMatchObject([{ url: sourceUrl, host: 'makerworld.com' }])
    const sidecar = JSON.parse(
      await readFile(path.join(root, model!.path, '.printbench.json'), 'utf8'),
    )
    expect(sidecar).toMatchObject({ name: 'My revised bracket name', notes: fixture.description })
    expect(JSON.stringify(sidecar)).toContain(sourceUrl)
    expect(await readFile(path.join(root, model!.path, 'profile-456.3mf'))).toEqual(modelBytes)
  })

  it('rolls back metadata when provenance insertion fails and preserves a later user edit on retry', async () => {
    const { id } = await queued()
    // Keep provider identity valid and inject the failure at the database
    // boundary, after metadata updates but before provenance commits.
    const deps = dependencies()
    const originalTransaction = db.transaction.bind(db)
    const transaction = vi.spyOn(db, 'transaction').mockImplementation((callback, config) =>
      originalTransaction(async (tx) => {
        const originalInsert = tx.insert.bind(tx)
        tx.insert = ((table: Parameters<typeof tx.insert>[0]) => {
          if (table === schema.modelLinks) throw new Error('Injected provenance failure')
          return originalInsert(table)
        }) as typeof tx.insert
        return callback(tx)
      }, config),
    )
    try {
      await processMakerWorldImport(db, id, deps)
    } finally {
      transaction.mockRestore()
    }
    expect((await job(id)).state).toBe('failed')
    const [model] = await db
      .select()
      .from(schema.models)
      .where(eq(schema.models.libraryId, libraryId))
    expect(model).toBeDefined()
    expect(model!.name).not.toBe(fixture.title)
    expect(model).toMatchObject({
      notes: null,
      license: null,
      creatorId: null,
      embeddedMetadataState: 'pending',
    })
    await expect(readFile(path.join(root, model!.path, '.printbench.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(
      await db.select().from(schema.modelTags).where(eq(schema.modelTags.modelId, model!.id)),
    ).toHaveLength(0)
    expect(
      await db.select().from(schema.modelLinks).where(eq(schema.modelLinks.modelId, model!.id)),
    ).toHaveLength(0)

    const [reservedFile] = await db
      .select()
      .from(schema.modelFiles)
      .where(eq(schema.modelFiles.modelId, model!.id))
    expect((await job(id)).modelId).toBe(model!.id)
    expect(await isEmbeddedMetadataSource(db, model!.id, reservedFile!.id)).toBe(false)
    expect(await applyEmbeddedModelMetadata(db, model!.id, reservedFile!.id, {})).toMatchObject({
      applied: false,
      reason: 'Source import metadata is reserved.',
    })
    // A failed metadata transaction must release the library mutex: ordinary
    // scans still index geometry, while the failed source job reserves metadata.
    expect(
      (
        await scanLibrary({
          db,
          storage: new LocalAdapter({
            id: libraryId,
            kind: 'managed',
            backend: 'local',
            path: root,
            allowWrites: true,
          }),
          library: {
            id: libraryId,
            kind: 'managed',
            backend: 'local',
            path: root,
            allowWrites: true,
          },
        })
      ).status,
    ).toBe('succeeded')
    await updateModel(db, model!.id, {
      name: 'My repaired bracket',
      notes: 'My own assembly instructions.',
    })
    deps.fetchModel.mockResolvedValue(fixture)
    expect(
      (await createMakerWorldImport(db, { userId: memberId, libraryId, url: sourceUrl })).id,
    ).toBe(id)
    await processMakerWorldImport(db, id, deps)
    expect((await job(id)).state).toBe('complete')
    expect(deps.download).toHaveBeenCalledTimes(1)
    const [after] = await db.select().from(schema.models).where(eq(schema.models.id, model!.id))
    expect(after).toMatchObject({
      name: 'My repaired bracket',
      notes: 'My own assembly instructions.',
      embeddedMetadataState: 'done',
    })
    expect(
      await db.select().from(schema.modelLinks).where(eq(schema.modelLinks.modelId, model!.id)),
    ).toMatchObject([{ url: sourceUrl }])
    const sidecar = JSON.parse(
      await readFile(path.join(root, model!.path, '.printbench.json'), 'utf8'),
    )
    expect(sidecar).toMatchObject({
      name: 'My repaired bracket',
      notes: 'My own assembly instructions.',
    })
    expect(JSON.stringify(sidecar)).toContain(sourceUrl)
  })

  it('removes partial and previously staged files when a later download fails', async () => {
    const { id } = await queued()
    const deps = dependencies({
      ...fixture,
      files: [
        ...fixture.files,
        {
          profileId: '789',
          filename: 'second.3mf',
          url: 'https://makerworld.bblmw.com/second.3mf',
        },
      ],
    })
    deps.download.mockResolvedValueOnce(Readable.from([modelBytes])).mockResolvedValueOnce(
      Readable.from(
        (async function* () {
          yield Buffer.from('partial')
          throw new Error(`stream failure ${token}`)
        })(),
      ),
    )
    await processMakerWorldImport(db, id, deps)
    expect((await job(id)).state).toBe('failed')
    expect((await job(id)).error).not.toContain(token)
    expect(await filesOnDisk()).toHaveLength(0)
    expect(
      await db.select().from(schema.models).where(eq(schema.models.libraryId, libraryId)),
    ).toHaveLength(0)
  })

  it('only marks queue failure for the owning queued request', async () => {
    const { id } = await queued()
    await markMakerWorldImportQueueFailed(db, otherId, id)
    expect((await job(id)).state).toBe('queued')
    await markMakerWorldImportQueueFailed(db, memberId, id)
    expect((await job(id)).state).toBe('failed')
    expect((await job(id)).error).toContain('queue')
  })
})
