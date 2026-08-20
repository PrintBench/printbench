import { createHash } from 'node:crypto'
import { and, eq, isNotNull } from 'drizzle-orm'
import { getDb, schema } from '@pm/db'
import {
  createStorageAdapter,
  getPreviewStore,
  libraryLocationFromRow,
  previewKey,
  type StorageAdapter,
} from '@pm/core'
import {
  MeshParseError,
  RENDERER_VERSION,
  analyzeMesh,
  boxSize,
  renderThumbnail,
  supportedFormat,
} from '@pm/mesh'
import type { JobPayload } from '@pm/jobs'
import { JOB } from '@pm/jobs'

const THUMBNAIL_SIZE = 512

/**
 * Per-file jobs: geometry analysis, thumbnail rendering, and content hashing.
 *
 * All three take only a file id and re-read current state, so a duplicated or
 * replayed delivery is harmless. Each records its outcome on the row — including
 * failures, which are stored rather than retried forever: a mesh that cannot be
 * parsed will not become parseable on the fourth attempt, and a queue that keeps
 * retrying it starves everything else.
 */

interface FileContext {
  file: typeof schema.modelFiles.$inferSelect
  storage: StorageAdapter
  relativePath: string
}

async function loadFile(fileId: string): Promise<FileContext | null> {
  const db = getDb()

  const rows = await db
    .select({
      file: schema.modelFiles,
      model: schema.models,
      library: schema.libraries,
    })
    .from(schema.modelFiles)
    .innerJoin(schema.models, eq(schema.models.id, schema.modelFiles.modelId))
    .innerJoin(schema.libraries, eq(schema.libraries.id, schema.models.libraryId))
    .where(eq(schema.modelFiles.id, fileId))
    .limit(1)

  const row = rows[0]
  if (!row) return null
  // Deleted from disk since the job was queued; nothing to do.
  if (row.file.missingAt) return null

  // A model that is a single loose file has no folder of its own.
  const relativePath = row.model.isFileModel
    ? row.model.path
    : `${row.model.path}/${row.file.filename}`

  return {
    file: row.file,
    storage: createStorageAdapter(libraryLocationFromRow(row.library)),
    relativePath,
  }
}

/** Geometry: bounding box, triangle count, units. Cheap, and drives UI badges. */
export async function handleFileAnalyze(
  payload: JobPayload<typeof JOB.fileAnalyze>,
): Promise<void> {
  const context = await loadFile(payload.fileId)
  if (!context) return

  const db = getDb()
  const { file, storage, relativePath } = context
  const format = supportedFormat(file.extension)

  if (!format) {
    await db
      .update(schema.modelFiles)
      .set({ analysisState: 'skipped' })
      .where(eq(schema.modelFiles.id, file.id))
    return
  }

  try {
    const stats = await analyzeMesh(format, () => storage.createReadStream(relativePath), {
      byteLength: file.size ?? undefined,
    })

    const size = stats.bbox ? boxSize(stats.bbox) : { x: 0, y: 0, z: 0 }

    await db
      .update(schema.modelFiles)
      .set({
        triangleCount: stats.triangleCount,
        bboxX: size.x.toFixed(4),
        bboxY: size.y.toFixed(4),
        bboxZ: size.z.toFixed(4),
        // Only 3MF declares units. STL, OBJ and PLY are unitless by
        // specification, so millimetres is an assumption, not a fact.
        bboxUnit: stats.unit ?? 'mm',
        analysisState: 'ok',
        analysisError: null,
      })
      .where(eq(schema.modelFiles.id, file.id))
  } catch (error) {
    await recordFailure(file.id, 'analysisState', 'analysisError', error)
  }
}

/** Thumbnail: the expensive one, and the reason the grid stops looking empty. */
export async function handleFileThumbnail(
  payload: JobPayload<typeof JOB.fileThumbnail>,
): Promise<void> {
  const context = await loadFile(payload.fileId)
  if (!context) return

  const db = getDb()
  const { file, storage, relativePath } = context
  const format = supportedFormat(file.extension)

  if (!format) {
    await db
      .update(schema.modelFiles)
      .set({ thumbState: 'skipped' })
      .where(eq(schema.modelFiles.id, file.id))
    return
  }

  const key = previewKey({
    fileId: file.id,
    digest: file.digest,
    size: file.size,
    mtimeMs: file.mtimeMs,
    size_px: THUMBNAIL_SIZE,
    rendererVersion: RENDERER_VERSION,
    format: 'webp',
  })

  const store = getPreviewStore()

  // Content-addressed, so an identical file already rendered elsewhere in the
  // library costs nothing to "render" again.
  if (await store.has(key)) {
    await db
      .update(schema.modelFiles)
      .set({ thumbKey: key, thumbState: 'ok', thumbError: null })
      .where(eq(schema.modelFiles.id, file.id))
    return
  }

  try {
    const result = await renderThumbnail(format, () => storage.createReadStream(relativePath), {
      size: THUMBNAIL_SIZE,
      format: 'webp',
      byteLength: file.size ?? undefined,
    })

    await store.write(key, result.data)

    await db
      .update(schema.modelFiles)
      .set({ thumbKey: key, thumbState: 'ok', thumbError: null })
      .where(eq(schema.modelFiles.id, file.id))
  } catch (error) {
    await recordFailure(file.id, 'thumbState', 'thumbError', error)
  }
}

/**
 * sha256 of the file contents.
 *
 * Streamed, so a 6 GB STL hashes in constant memory. Lowest priority of the
 * three jobs: nothing user-facing depends on it. It exists to power duplicate
 * detection and rename detection — which is what lets someone reorganise
 * their library without losing tags and thumbnails.
 */
export async function handleFileDigest(payload: JobPayload<typeof JOB.fileDigest>): Promise<void> {
  const context = await loadFile(payload.fileId)
  if (!context) return

  const { file, storage, relativePath } = context

  try {
    const stream = await storage.createReadStream(relativePath)
    const hash = createHash('sha256')
    for await (const chunk of stream) hash.update(chunk as Buffer)
    const digest = hash.digest('hex')

    await getDb()
      .update(schema.modelFiles)
      .set({ digest })
      .where(eq(schema.modelFiles.id, file.id))

    // Only a file that had no digest before is a candidate: one whose content
    // changed already had a digest, and re-matching it against something
    // "missing" would misfile an edit as a rename.
    if (file.digest === null) {
      await resolveRename(file, digest)
    }
  } catch (error) {
    console.warn(`[digest] ${file.filename}: ${message(error)}`)
  }
}

/**
 * Matches a brand-new file row against a missing one in the same model with
 * identical (size, digest), and folds them into a single row.
 *
 * The scan can't do this itself: at scan time the new file has no digest yet
 * — only mtime and size, which are exactly the values that collide across the
 * many identically-sized parts a print library contains (a plate of the same
 * screw, presupported and unsupported variants of the same body). Content
 * hashing is the only signal precise enough to trust, and it only exists once
 * this job has run.
 *
 * The MISSING row survives — it already carries a real thumbnail, analysis
 * and digest — and adopts the new row's current name and path-derived fields.
 * The just-inserted row is discarded once its identity has been folded in.
 * Two matches means an ambiguous rename (say, two identical spare parts
 * renamed at once) and is left alone rather than guessed at.
 */
async function resolveRename(
  fresh: typeof schema.modelFiles.$inferSelect,
  digest: string,
): Promise<void> {
  const db = getDb()

  const candidates = await db
    .select()
    .from(schema.modelFiles)
    .where(
      and(
        eq(schema.modelFiles.modelId, fresh.modelId),
        isNotNull(schema.modelFiles.missingAt),
        eq(schema.modelFiles.digest, digest),
        eq(schema.modelFiles.size, fresh.size),
      ),
    )
    .limit(2)

  if (candidates.length !== 1) return
  const previous = candidates[0]!

  await db.transaction(async (tx) => {
    /*
     * Deleted first, not second: (model_id, filename) is unique, and until
     * this row is gone the update below — giving `previous` that same
     * filename — would collide with the row it is about to replace.
     */
    await tx.delete(schema.modelFiles).where(eq(schema.modelFiles.id, fresh.id))

    await tx
      .update(schema.modelFiles)
      .set({
        filename: fresh.filename,
        extension: fresh.extension,
        mediaType: fresh.mediaType,
        category: fresh.category,
        previewable: fresh.previewable,
        presupported: fresh.presupported,
        size: fresh.size,
        mtimeMs: fresh.mtimeMs,
        etag: fresh.etag,
        lastSeenAt: fresh.lastSeenAt,
        missingAt: null,
      })
      .where(eq(schema.modelFiles.id, previous.id))
  })

  console.log(`[digest] treated "${fresh.filename}" as a rename of a missing file, id kept`)
}

async function recordFailure(
  fileId: string,
  stateColumn: 'analysisState' | 'thumbState',
  errorColumn: 'analysisError' | 'thumbError',
  error: unknown,
): Promise<void> {
  const text = message(error)
  /*
   * Recorded as failed rather than rethrown. A malformed mesh will not parse
   * on the fourth attempt, and letting the queue retry it forever starves
   * every other file behind it. The reason is stored so the health dashboard
   * can show what went wrong.
   */
  await getDb()
    .update(schema.modelFiles)
    .set({ [stateColumn]: 'failed', [errorColumn]: text.slice(0, 500) })
    .where(eq(schema.modelFiles.id, fileId))

  if (!(error instanceof MeshParseError)) {
    console.warn(`[${stateColumn}] unexpected failure on ${fileId}: ${text}`)
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
