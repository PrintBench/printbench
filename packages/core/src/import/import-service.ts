import { and, eq, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { Readable } from 'node:stream'
import type { Database } from '@pb/db'
import { schema } from '@pb/db'
import { assertCan } from '../policy/policy'
import { decryptSecret, encryptSecret } from '../security/secret-box'
import { createStorageAdapter, libraryLocationFromRow } from '../storage/factory'
import { scanLibrary } from '../scan/scan-service'
import { updateModel, syncSidecar } from '../services/model-service'
import type { StorageAdapter } from '../storage/types'
import {
  ImportProviderError,
  normalizeMakerWorldCookie,
  parseMakerWorldUrl,
  type MakerWorldModel,
} from './makerworld'

/** Only deliberately safe, user-facing messages cross the server-action boundary. */
export class MakerWorldImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MakerWorldImportError'
  }
}

const validId = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

async function authorize(db: Database, userId: string): Promise<void> {
  const [user] = await db.select().from(schema.user).where(eq(schema.user.id, userId)).limit(1)
  assertCan(user ?? null, 'file:upload')
}

export async function getMakerWorldCookieStatus(db: Database, userId: string): Promise<boolean> {
  await authorize(db, userId)
  const [row] = await db
    .select()
    .from(schema.providerCredentials)
    .where(eq(schema.providerCredentials.userId, userId))
    .limit(1)
  return Boolean(decryptSecret(row?.makerWorldCookieEncrypted))
}

export async function saveMakerWorldCookie(
  db: Database,
  userId: string,
  cookie: string,
): Promise<void> {
  await authorize(db, userId)
  if (!cookie.trim()) {
    await db.delete(schema.providerCredentials).where(eq(schema.providerCredentials.userId, userId))
    return
  }
  let token: string
  try {
    token = normalizeMakerWorldCookie(cookie)
  } catch {
    throw new MakerWorldImportError('Paste the MakerWorld token cookie or its value.')
  }
  const encrypted = encryptSecret(token)
  await db
    .insert(schema.providerCredentials)
    .values({ userId, makerWorldCookieEncrypted: encrypted })
    .onConflictDoUpdate({
      target: schema.providerCredentials.userId,
      set: { makerWorldCookieEncrypted: encrypted, updatedAt: new Date() },
    })
}

export async function createMakerWorldImport(
  db: Database,
  input: {
    userId: string
    libraryId: string
    url: string
  },
): Promise<{ id: string }> {
  await authorize(db, input.userId)
  if (!validId(input.libraryId)) throw new MakerWorldImportError('Choose a writable library.')
  let parsed: ReturnType<typeof parseMakerWorldUrl>
  try {
    parsed = parseMakerWorldUrl(input.url)
  } catch {
    throw new MakerWorldImportError('Enter an https://makerworld.com model-page URL.')
  }
  const [library] = await db
    .select()
    .from(schema.libraries)
    .where(eq(schema.libraries.id, input.libraryId))
    .limit(1)
  if (!library || (library.kind !== 'managed' && !library.allowWrites)) {
    throw new MakerWorldImportError('That library is read-only or no longer exists.')
  }
  if (!library.scanEnabled || (library.backend === 'local' ? !library.path : !library.s3Bucket)) {
    throw new MakerWorldImportError('That library needs working storage and scanning enabled.')
  }
  if (!(await getMakerWorldCookieStatus(db, input.userId))) {
    throw new MakerWorldImportError('Save your MakerWorld cookie before importing.')
  }
  const sourceUrl = parsed.sourceUrl + (parsed.profileId ? `#profileId-${parsed.profileId}` : '')
  const [created] = await db
    .insert(schema.modelImports)
    .values({
      userId: input.userId,
      libraryId: input.libraryId,
      sourceUrl,
    })
    .onConflictDoNothing()
    .returning({ id: schema.modelImports.id })
  if (created) return created
  const [existing] = await db
    .select()
    .from(schema.modelImports)
    .where(
      and(
        eq(schema.modelImports.libraryId, input.libraryId),
        eq(schema.modelImports.sourceUrl, sourceUrl),
      ),
    )
    .limit(1)
  if (!existing || existing.userId !== input.userId) {
    throw new MakerWorldImportError('This link is already being imported into that library.')
  }
  if (existing.state === 'failed' || (existing.state === 'complete' && !existing.modelId)) {
    await db
      .update(schema.modelImports)
      .set({ state: 'queued', error: null, updatedAt: new Date() })
      .where(eq(schema.modelImports.id, existing.id))
  }
  return { id: existing.id }
}

export async function getMakerWorldImportStatus(db: Database, userId: string, id: string) {
  await authorize(db, userId)
  if (!validId(id)) return null
  const [row] = await db
    .select({
      state: schema.modelImports.state,
      error: schema.modelImports.error,
      publicId: schema.models.publicId,
    })
    .from(schema.modelImports)
    .leftJoin(schema.models, eq(schema.models.id, schema.modelImports.modelId))
    .where(and(eq(schema.modelImports.id, id), eq(schema.modelImports.userId, userId)))
    .limit(1)
  return row ?? null
}

export async function markMakerWorldImportQueueFailed(
  db: Database,
  userId: string,
  id: string,
): Promise<void> {
  await db
    .update(schema.modelImports)
    .set({
      state: 'failed',
      error: 'Could not queue the import. Try again.',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.modelImports.id, id),
        eq(schema.modelImports.userId, userId),
        eq(schema.modelImports.state, 'queued'),
      ),
    )
}

export interface MakerWorldImportDependencies {
  fetchModel: (url: string, token: string) => Promise<MakerWorldModel>
  /** Worker owns temporary download files and format validation. */
  download: (url: string, kind: '3mf' | 'image') => Promise<Readable>
  onDerivedWork?: (fileIds: string[]) => Promise<void>
}

/** Heavy work belongs in the worker; queue data contains only the request id. */
export async function processMakerWorldImport(
  db: Database,
  id: string,
  deps: MakerWorldImportDependencies,
): Promise<void> {
  // Hold only an advisory lock in this transaction: progress remains visible
  // through the ordinary connection and duplicate workers cannot race retries.
  await db.transaction(async (lock) => {
    const result = await lock.execute(
      sql`select pg_try_advisory_xact_lock(hashtextextended(${id}, 0)) as acquired`,
    )
    if (result.rows[0]?.acquired) await runMakerWorldImport(db, id, deps)
  })
}

async function runMakerWorldImport(
  db: Database,
  id: string,
  deps: MakerWorldImportDependencies,
): Promise<void> {
  const [job] = await db
    .select()
    .from(schema.modelImports)
    .where(eq(schema.modelImports.id, id))
    .limit(1)
  if (!job || job.state === 'complete' || job.state === 'failed') return
  let importStorage: StorageAdapter | undefined
  const temporaryPaths: string[] = []
  await db
    .update(schema.modelImports)
    .set({ state: 'importing', error: null, updatedAt: new Date() })
    .where(eq(schema.modelImports.id, id))
  try {
    // A role change or disconnected credential takes effect even on queued jobs.
    await authorize(db, job.userId)
    const [library] = await db
      .select()
      .from(schema.libraries)
      .where(eq(schema.libraries.id, job.libraryId))
      .limit(1)
    if (!library || (library.kind !== 'managed' && !library.allowWrites) || !library.scanEnabled) {
      throw new MakerWorldImportError(
        'The destination library is no longer writable or scanning is disabled.',
      )
    }
    const [credential] = await db
      .select()
      .from(schema.providerCredentials)
      .where(eq(schema.providerCredentials.userId, job.userId))
      .limit(1)
    const token = decryptSecret(credential?.makerWorldCookieEncrypted)
    if (!token)
      throw new MakerWorldImportError('Your MakerWorld cookie is unavailable. Save it again.')
    const model = await deps.fetchModel(job.sourceUrl, token)
    if (!model.files.length || model.files.length > 20) {
      throw new MakerWorldImportError('This model has no downloadable print profile.')
    }
    const storage = createStorageAdapter(libraryLocationFromRow(library))
    importStorage = storage
    // The request's UUID reserves its own folder. A retry never overwrites an
    // existing library model or treats someone else's folder as staging space.
    const folder = `makerworld-${parseMakerWorldUrl(job.sourceUrl).externalId}-${job.id}`
    const staged: { from: string; to: string }[] = []
    for (const file of model.files) {
      if (!/^[1-9]\d{0,15}$/.test(file.profileId))
        throw new MakerWorldImportError('Invalid MakerWorld print profile.')
      const to = `${folder}/profile-${file.profileId}.3mf`
      if (await storage.stat(to)) continue
      const from = `.imports/${job.id}/profile-${file.profileId}-${nanoid(8)}.3mf`
      temporaryPaths.push(from)
      try {
        await storage.write(from, await deps.download(file.url, '3mf'))
      } catch (error) {
        await storage.remove(from).catch(() => undefined)
        throw error
      }
      staged.push({ from, to })
    }
    if (model.thumbnailUrl && !(await storage.stat(`${folder}/cover.webp`))) {
      const from = `.imports/${job.id}/cover-${nanoid(8)}.webp`
      temporaryPaths.push(from)
      try {
        await storage.write(from, await deps.download(model.thumbnailUrl, 'image'))
        staged.push({ from, to: `${folder}/cover.webp` })
      } catch {
        await storage.remove(from).catch(() => undefined)
        // Optional remote artwork never blocks a usable 3MF import.
      }
    }
    for (const file of staged) await storage.move(file.from, file.to)
    const derived: string[] = []
    const location = { ...libraryLocationFromRow(library), groupingMode: library.groupingMode }
    const outcome = await scanLibrary(
      { db, storage, library: location },
      {
        mode: 'deep',
        onDerivedWork: (ids) => {
          derived.push(...ids)
        },
      },
    )
    if (outcome.status !== 'succeeded')
      throw new MakerWorldImportError(
        'Files were downloaded, but the library scan could not finish. Try again.',
      )
    const [imported] = await db
      .select()
      .from(schema.models)
      .where(and(eq(schema.models.libraryId, library.id), eq(schema.models.path, folder)))
      .limit(1)
    if (!imported)
      throw new MakerWorldImportError('The library could not index the downloaded model.')
    // Metadata and its provenance marker commit together. A row lock also
    // preserves an edit made after an interrupted attempt, even without a link.
    await db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database
      const locked = await tx.execute<{ embedded_metadata_state: string }>(sql`
        SELECT embedded_metadata_state FROM models WHERE id = ${imported.id} FOR UPDATE
      `)
      if (!locked.rows[0]) throw new MakerWorldImportError('The downloaded model no longer exists.')
      const [previousSource] = await tx
        .select({ id: schema.modelLinks.id })
        .from(schema.modelLinks)
        .where(
          and(
            eq(schema.modelLinks.modelId, imported.id),
            eq(schema.modelLinks.url, model.sourceUrl),
          ),
        )
        .limit(1)
      if (!previousSource && locked.rows[0].embedded_metadata_state === 'pending') {
        const saved = await updateModel(
          tx,
          imported.id,
          {
            name: model.title,
            notes: model.description,
            license: model.license?.slice(0, 120) ?? null,
            creator: model.creator?.name ?? null,
            tags: model.tags,
          },
          { deferSidecar: true },
        )
        if (!saved.ok)
          throw new MakerWorldImportError('The downloaded model metadata could not be saved.')
      }
      await tx
        .insert(schema.modelLinks)
        .values({
          modelId: imported.id,
          url: model.sourceUrl,
          host: 'makerworld.com',
          title: 'MakerWorld',
        })
        .onConflictDoNothing()
    })
    await syncSidecar(db, imported.id)
    // A retry may find already-indexed files after queueing failed. Include the
    // imported model's live files so that those jobs are not lost on replay.
    const liveFiles = await db
      .select({ id: schema.modelFiles.id })
      .from(schema.modelFiles)
      .where(
        and(
          eq(schema.modelFiles.modelId, imported.id),
          sql`${schema.modelFiles.missingAt} is null`,
        ),
      )
    await deps.onDerivedWork?.([...new Set([...derived, ...liveFiles.map((file) => file.id)])])
    await db
      .update(schema.modelImports)
      .set({ state: 'complete', modelId: imported.id, error: null, updatedAt: new Date() })
      .where(eq(schema.modelImports.id, id))
  } catch (error) {
    // Never persist arbitrary network errors or signed URLs, let alone a token.
    const message =
      error instanceof MakerWorldImportError || error instanceof ImportProviderError
        ? error.message
        : 'Import failed. Check the connection, storage, and MakerWorld access, then try again.'
    await db
      .update(schema.modelImports)
      .set({ state: 'failed', error: message, updatedAt: new Date() })
      .where(eq(schema.modelImports.id, id))
  } finally {
    for (const temporary of temporaryPaths)
      await importStorage?.remove(temporary).catch(() => undefined)
  }
}
