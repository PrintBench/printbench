import { eq, inArray } from 'drizzle-orm'
import { getDb, schema } from '@pb/db'
import {
  MoveError,
  createStorageAdapter,
  libraryLocationFromRow,
  moveModelToLibrary,
} from '@pb/core'
import type { JobPayload } from '@pb/jobs'
import { JOB, getQueue } from '@pb/jobs'

/**
 * Moves a model into another library.
 *
 * Here rather than in a server action for the same reason uploads and ZIPs
 * are: a move between two backends copies every byte through this process, and
 * a multi-gigabyte pack would occupy the process rendering pages for minutes.
 * A move between two local libraries on one volume is a handful of renames and
 * finishes before the page has finished revalidating — but the slow case is
 * the one that decides where this runs.
 *
 * Not idempotent in the way the render jobs are, and cannot be: the second run
 * of a completed move finds the files gone from the source and refuses. That
 * is the safe direction — it declines rather than moving something else — but
 * it is why the queue is `stately`, so a replay is unlikely rather than
 * routine.
 */
export async function handleModelMove(payload: JobPayload<typeof JOB.modelMove>): Promise<void> {
  const db = getDb()

  const model = await db
    .select({ id: schema.models.id, libraryId: schema.models.libraryId })
    .from(schema.models)
    .where(eq(schema.models.id, payload.modelId))
    .limit(1)

  const found = model[0]
  if (!found) {
    // Deleted between enqueue and execution. Retrying will not bring it back.
    console.warn(`[move] model ${payload.modelId} no longer exists, skipping`)
    return
  }

  if (found.libraryId === payload.destinationLibraryId) {
    /*
     * Already there. Overwhelmingly likely to be this job running twice rather
     * than a genuine mistake, and treating it as a failure would raise an
     * alarm about a move that worked.
     */
    console.log(`[move] model ${payload.modelId} is already in the destination, nothing to do`)
    return
  }

  const libraries = await db
    .select()
    .from(schema.libraries)
    .where(inArray(schema.libraries.id, [found.libraryId, payload.destinationLibraryId]))

  const sourceRow = libraries.find((row) => row.id === found.libraryId)
  const destinationRow = libraries.find((row) => row.id === payload.destinationLibraryId)

  if (!sourceRow || !destinationRow) {
    console.warn(`[move] a library involved in moving ${payload.modelId} no longer exists`)
    return
  }

  const source = createStorageAdapter(libraryLocationFromRow(sourceRow))
  const destination = createStorageAdapter(libraryLocationFromRow(destinationRow))

  const started = Date.now()

  let result
  try {
    result = await moveModelToLibrary(db, source, destination, payload.modelId, {
      destinationPath: payload.destinationPath,
    })
  } catch (error) {
    /*
     * A refusal is not a failure. Every MoveError is a considered "no" — the
     * destination is occupied, a library turned out to be read-only, a scan
     * started — and the service has already left both libraries as it found
     * them. Throwing would retry it, hit the same answer, and eventually mark
     * the job failed for a decision rather than a fault.
     */
    if (error instanceof MoveError) {
      console.warn(`[move] declined to move ${payload.modelId}: ${error.message}`)
      return
    }
    throw error
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  console.log(
    `[move] "${result.name}" from "${sourceRow.name}" to "${destinationRow.name}" ` +
      `in ${seconds}s — ${result.filesMoved} file(s), ${result.strategy}` +
      (result.sourceFolderKept ? ', source folder kept (other files in it)' : '') +
      (result.filesSkipped > 0 ? `, ${result.filesSkipped} already missing` : ''),
  )

  /*
   * Both libraries, fast mode.
   *
   * The model itself needs neither — its row and file rows are already
   * correct, which is the whole point of moving rather than re-uploading. The
   * scans are for the two libraries' own bookkeeping: the source has directory
   * fingerprints for a folder that is gone, and the destination has none for
   * the folder that arrived, so without this the next fast scan of either can
   * skip past what changed.
   */
  for (const libraryId of [sourceRow.id, destinationRow.id]) {
    await getQueue().send(
      JOB.libraryScan,
      { libraryId, mode: 'fast', force: false },
      { singletonKey: `scan:${libraryId}` },
    )
  }
}
