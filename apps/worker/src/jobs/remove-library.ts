import { getDb } from '@pb/db'
import { SYSTEM_ACTOR, carryOutLibraryRemoval, recordAudit } from '@pb/core'
import type { JobPayload } from '@pb/jobs'
import { JOB } from '@pb/jobs'

/**
 * Removes a library that was asked to delete its files or move its models.
 *
 * Here rather than in the server action, like a model move: emptying a bucket
 * or carrying hundreds of models across backends is minutes of I/O, and has
 * no business in the process rendering pages. What to do was recorded on the
 * library row when it was requested; `carryOutLibraryRemoval` reads it from
 * there and, if anything is left behind, records why on the same row.
 */
export async function handleLibraryRemove(
  payload: JobPayload<typeof JOB.libraryRemove>,
): Promise<void> {
  const db = getDb()
  const started = Date.now()
  const outcome = await carryOutLibraryRemoval(db, payload.libraryId)

  if (outcome.status === 'nothing_to_do') {
    console.log(`[remove] library ${payload.libraryId} has no removal pending, skipping`)
    return
  }

  const target = { type: 'library', id: payload.libraryId, label: outcome.name }
  const detail = {
    mode: outcome.mode,
    ...(outcome.mode === 'delete_files'
      ? { filesDeleted: outcome.filesDeleted, bytesFreed: outcome.bytesFreed }
      : {
          modelsMoved: outcome.modelsMoved,
          modelsMissing: outcome.modelsMissing,
          foldersKept: outcome.foldersKept,
        }),
    seconds: Math.round((Date.now() - started) / 1000),
  }

  if (outcome.status === 'removed') {
    console.log(`[remove] removed "${outcome.name}" (${outcome.mode})`, detail)
    await recordAudit(db, { action: 'library.deleted', actor: SYSTEM_ACTOR, target, detail })
    return
  }

  console.warn(`[remove] removing "${outcome.name}" stopped: ${outcome.error}`)
  await recordAudit(db, {
    action: 'library.removal_stopped',
    outcome: 'failure',
    actor: SYSTEM_ACTOR,
    target,
    detail: { ...detail, failures: outcome.failures.length, reason: outcome.error },
  })
}
