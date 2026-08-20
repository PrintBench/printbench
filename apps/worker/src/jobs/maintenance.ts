import { sql } from 'drizzle-orm'
import { getDb } from '@pm/db'
import { getSettings, prune } from '@pm/core'
import { JOB, getQueue } from '@pm/jobs'

/**
 * The two maintenance sweeps.
 *
 * `reconcile` re-enqueues derived work that was lost — a worker killed
 * mid-render leaves a file pending forever otherwise, and the symptom is a
 * thumbnail that simply never appears.
 *
 * `archive` is the only scheduled job that deletes anything. It defers the
 * policy to prune(), which refuses to touch a library where every model is
 * missing, because that is an unmounted drive rather than a deletion.
 */

/** Enough to make progress each pass without flooding the queue. */
const RECONCILE_BATCH = 500

export async function handleMaintReconcile(): Promise<void> {
  const db = getDb()
  const queue = getQueue()

  /*
   * Files stuck pending with nothing queued for them. The age filter matters:
   * without it this would re-enqueue work that was handed out seconds ago and
   * is still running.
   */
  const stale = await db.execute<{ id: string; needs_analysis: boolean; needs_thumb: boolean }>(sql`
    SELECT f.id,
           (f.analysis_state = 'pending') AS needs_analysis,
           (f.thumb_state = 'pending')    AS needs_thumb
    FROM model_files f
    WHERE f.missing_at IS NULL AND f.previewable
      AND (f.analysis_state = 'pending' OR f.thumb_state = 'pending')
      AND f.created_at < now() - '15 minutes'::interval
    ORDER BY f.created_at
    LIMIT ${RECONCILE_BATCH}`)

  if (stale.rows.length === 0) return

  const analyse = stale.rows.filter((row) => row.needs_analysis).map((row) => ({ fileId: row.id }))
  const thumbs = stale.rows.filter((row) => row.needs_thumb).map((row) => ({ fileId: row.id }))

  if (analyse.length > 0) await queue.sendMany(JOB.fileAnalyze, analyse)
  if (thumbs.length > 0) await queue.sendMany(JOB.fileThumbnail, thumbs)

  console.log(
    `[maint] re-enqueued ${analyse.length} analyses and ${thumbs.length} thumbnails ` +
      'that were left pending',
  )
}

export async function handleMaintArchive(): Promise<void> {
  const db = getDb()

  // The grace period is a setting, so an operator who wants a shorter or longer
  // one gets it without a redeploy.
  const { missingGraceDays } = await getSettings(db)
  const result = await prune(db, { graceDays: missingGraceDays })

  if (result.librariesSkipped.length > 0) {
    console.warn(
      `[maint] skipped ${result.librariesSkipped.join(', ')} — every model missing, ` +
        'which looks like an unmounted drive rather than a deletion',
    )
  }

  if (result.modelsDeleted + result.filesDeleted > 0) {
    console.log(
      `[maint] removed ${result.modelsDeleted} models and ${result.filesDeleted} files ` +
        `missing for more than ${missingGraceDays} days`,
    )
  }

  if (result.scanRunsDeleted + result.problemsDeleted > 0) {
    console.log(
      `[maint] archived ${result.scanRunsDeleted} scan runs and ` +
        `${result.problemsDeleted} resolved problems`,
    )
  }
}
