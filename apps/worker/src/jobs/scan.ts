import { eq } from 'drizzle-orm'
import { getDb, schema } from '@pm/db'
import { LocalAdapter, S3Adapter, scanLibrary, type LibraryLocation } from '@pm/core'
import type { JobPayload } from '@pm/jobs'
import { JOB, getQueue } from '@pm/jobs'

/**
 * Runs a library scan.
 *
 * Idempotent by construction: it takes a library id, re-reads current state,
 * and reconciles. A replayed job simply scans again, which is a no-op when
 * nothing has changed.
 */
export async function handleLibraryScan(payload: JobPayload<typeof JOB.libraryScan>): Promise<void> {
  const db = getDb()

  const rows = await db
    .select()
    .from(schema.libraries)
    .where(eq(schema.libraries.id, payload.libraryId))
    .limit(1)

  const library = rows[0]
  if (!library) {
    // Deleted between enqueue and execution. Nothing to do, and retrying will
    // not help, so return rather than throw.
    console.warn(`[scan] library ${payload.libraryId} no longer exists, skipping`)
    return
  }

  if (!library.scanEnabled) {
    console.log(`[scan] library "${library.name}" has scanning disabled, skipping`)
    return
  }

  const location = toLocation(library)
  const storage = createAdapter(location)

  console.log(`[scan] starting ${payload.mode} scan of "${library.name}"`)
  const started = Date.now()

  const outcome = await scanLibrary(
    { db, storage, library: { ...location, groupingMode: library.groupingMode } as LibraryLocation },
    {
      mode: payload.mode,
      force: payload.force,
      /*
       * Fan out derived work in batches. A 50k-file library produces roughly a
       * hundred multi-row inserts rather than 150,000 individual ones.
       *
       * Analysis first: it is cheap and drives the dimension badges. Thumbnails
       * next, because they are what people actually look at. Digests last —
       * nothing user-facing waits on them.
       */
      onDerivedWork: async (fileIds) => {
        const queue = getQueue()
        const payloads = fileIds.map((fileId) => ({ fileId }))
        await queue.sendMany(JOB.fileAnalyze, payloads)
        await queue.sendMany(JOB.fileThumbnail, payloads)
        await queue.sendMany(JOB.fileDigest, payloads)
      },
    },
  )

  const seconds = ((Date.now() - started) / 1000).toFixed(1)

  if (outcome.status === 'aborted') {
    // Deliberately not thrown: an abort is a considered refusal, not a failure,
    // and retrying it would just abort again. It is surfaced in the UI instead.
    console.warn(
      `[scan] ABORTED "${library.name}" after ${seconds}s — ${outcome.abortReason}: ${outcome.abortDetail}`,
    )
    return
  }

  console.log(
    `[scan] finished "${library.name}" in ${seconds}s — ` +
      `${outcome.modelsCreated} new, ${outcome.modelsUpdated} updated, ` +
      `${outcome.modelsMissing} missing, ${outcome.filesSeen} files seen, ` +
      `${outcome.filesQueued} queued for rendering`,
  )

  if (outcome.errors.length > 0) {
    console.warn(`[scan] ${outcome.errors.length} directories could not be read`)
  }

  /*
   * Re-examine health now the library has changed. Enqueued rather than run
   * inline so a slow pass cannot hold the scan queue, and scoped to this
   * library so one scan does not re-examine the whole instance.
   *
   * Not after an abort: an aborted scan means the library is in an unknown
   * state — very likely an unmounted drive — and reporting every model as
   * missing is exactly the panic the abort exists to prevent.
   */
  await getQueue().send(JOB.healthDetect, { libraryId: library.id, skipCosmetic: false })
}

function toLocation(library: typeof schema.libraries.$inferSelect): LibraryLocation {
  return {
    id: library.id,
    kind: library.kind,
    backend: library.backend,
    allowWrites: library.allowWrites,
    path: library.path,
    s3Bucket: library.s3Bucket,
    s3Prefix: library.s3Prefix,
    s3Endpoint: library.s3Endpoint,
    s3Region: library.s3Region,
    s3AccessKeyId: library.s3AccessKeyId,
    s3SecretAccessKey: library.s3SecretAccessKey,
    s3ForcePathStyle: library.s3ForcePathStyle,
  }
}

function createAdapter(location: LibraryLocation) {
  switch (location.backend) {
    case 'local':
      return new LocalAdapter(location)
    case 's3':
      return new S3Adapter(location)
    default:
      throw new Error(`Unknown storage backend: ${String(location.backend)}`)
  }
}
