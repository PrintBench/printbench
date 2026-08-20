import { sql } from 'drizzle-orm'
import type { Database } from '@pm/db'

/**
 * Hard deletion, after the grace period.
 *
 * Everything in this application soft-deletes: a scan that cannot see a file
 * marks it missing rather than removing it, because the overwhelmingly likely
 * cause is an unmounted drive rather than an actual deletion. This is where
 * those rows finally go — and it is the only code in the project that destroys
 * metadata, so it is deliberately conservative.
 *
 * Two rules:
 *
 * Nothing is removed until it has been missing for the whole grace period,
 * measured from when it was first noticed missing, not from now.
 *
 * A library that is entirely missing is skipped whatever the age. That is the
 * signature of a drive that has been unplugged for a month, not of someone
 * deleting their collection — and getting it wrong destroys the metadata the
 * sidecars exist to protect.
 */

export interface PruneOptions {
  /** Days a missing row is kept. Comes from settings; never less than 1. */
  graceDays: number
  /** Report what would go without removing anything. */
  dryRun?: boolean
}

export interface PruneResult {
  modelsDeleted: number
  filesDeleted: number
  scanRunsDeleted: number
  problemsDeleted: number
  /** Libraries skipped because every model in them is missing. */
  librariesSkipped: string[]
}

/** Scan history older than this is noise; the recent runs are the useful ones. */
const SCAN_RUN_RETENTION_DAYS = 90

export async function prune(db: Database, options: PruneOptions): Promise<PruneResult> {
  const graceDays = Math.max(1, Math.round(options.graceDays))

  /*
   * Libraries where everything is missing. Almost certainly an unmounted
   * drive, so nothing in them is touched however long it has been.
   */
  const suspect = await db.execute<{ id: string; name: string }>(sql`
    SELECT l.id, l.name
    FROM libraries l
    JOIN models m ON m.library_id = l.id
    GROUP BY l.id, l.name
    HAVING count(*) FILTER (WHERE m.missing_at IS NULL) = 0`)

  const skipIds = suspect.rows.map((row) => row.id)
  const librariesSkipped = suspect.rows.map((row) => row.name)

  const notSkipped = skipIds.length
    ? sql`AND m.library_id <> ALL(${sql.param(skipIds)}::uuid[])`
    : sql``

  const cutoff = sql`now() - ${`${graceDays} days`}::interval`

  if (options.dryRun) {
    const counts = await db.execute<{ models: number; files: number }>(sql`
      SELECT
        (SELECT count(*)::int FROM models m
          WHERE m.missing_at IS NOT NULL AND m.missing_at < ${cutoff} ${notSkipped}) AS models,
        (SELECT count(*)::int FROM model_files f
          JOIN models m ON m.id = f.model_id
          WHERE f.missing_at IS NOT NULL AND f.missing_at < ${cutoff} ${notSkipped}) AS files`)

    return {
      modelsDeleted: counts.rows[0]?.models ?? 0,
      filesDeleted: counts.rows[0]?.files ?? 0,
      scanRunsDeleted: 0,
      problemsDeleted: 0,
      librariesSkipped,
    }
  }

  /*
   * Files first. A model's remaining files are removed by cascade when the
   * model goes, but a file that vanished from a model still present has to be
   * dealt with on its own.
   */
  const files = await db.execute(sql`
    DELETE FROM model_files f
    USING models m
    WHERE m.id = f.model_id
      AND f.missing_at IS NOT NULL AND f.missing_at < ${cutoff} ${notSkipped}`)

  const models = await db.execute(sql`
    DELETE FROM models m
    WHERE m.missing_at IS NOT NULL AND m.missing_at < ${cutoff} ${notSkipped}`)

  // Problems about things that no longer exist. The FK is ON DELETE CASCADE for
  // model-scoped rows; this catches any left resolved and stale.
  const problems = await db.execute(sql`
    DELETE FROM problems
    WHERE resolved_at IS NOT NULL AND resolved_at < now() - '30 days'::interval`)

  const scanRuns = await db.execute(sql`
    DELETE FROM scan_runs
    WHERE created_at < now() - ${`${SCAN_RUN_RETENTION_DAYS} days`}::interval`)

  return {
    modelsDeleted: models.rowCount ?? 0,
    filesDeleted: files.rowCount ?? 0,
    scanRunsDeleted: scanRuns.rowCount ?? 0,
    problemsDeleted: problems.rowCount ?? 0,
    librariesSkipped,
  }
}

/** What is currently missing and how close it is to being removed. */
export async function pendingDeletions(
  db: Database,
  graceDays: number,
): Promise<{ modelId: string; name: string; missingSince: Date; daysLeft: number }[]> {
  const rows = await db.execute<{
    id: string
    name: string
    missing_at: string
    days_left: number
  }>(sql`
    SELECT m.id, m.name, m.missing_at,
           GREATEST(0, ${Math.max(1, Math.round(graceDays))} -
             EXTRACT(DAY FROM now() - m.missing_at))::int AS days_left
    FROM models m
    WHERE m.missing_at IS NOT NULL
    ORDER BY m.missing_at ASC
    LIMIT 500`)

  return rows.rows.map((row) => ({
    modelId: row.id,
    name: row.name,
    missingSince: new Date(row.missing_at),
    daysLeft: row.days_left,
  }))
}
