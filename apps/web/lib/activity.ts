import { sql } from 'drizzle-orm'
import type { Database } from '@pb/db'
import { activityJobs, JOB } from '@pb/jobs'
import type { Db as IDatabase } from 'pg-boss'

export interface Activity {
  id: string
  kind: 'processing' | 'scan' | 'health'
  state: 'queued' | 'running' | 'completed' | 'failed'
  label: string
  href: '/models' | '/admin/libraries' | '/admin/health'
  count?: number
  failures?: number
  createdAt?: string
}

/** Model counts include every library, even when none of its cards are mounted. */
export async function readActivity(
  db: Database,
  queueDb: IDatabase,
  includeOperations: boolean,
  trackedIds: string[] = [],
): Promise<Activity[]> {
  const [models, jobs] = await Promise.all([
    db.execute<{ pending: number; failed: number }>(sql`
      SELECT count(*) FILTER (WHERE pending)::int AS pending,
             count(*) FILTER (WHERE failed AND NOT pending)::int AS failed
      FROM (
        SELECT m.id,
          bool_or(f.thumb_state = 'pending') AS pending,
          bool_or(f.thumb_state = 'failed') AS failed
        FROM models m
        JOIN model_files f ON f.model_id = m.id
        WHERE m.missing_at IS NULL AND f.missing_at IS NULL AND f.previewable
          AND f.thumb_state IN ('pending', 'failed')
        GROUP BY m.id
      ) processing
    `),
    includeOperations ? activityJobs(queueDb, 'pgboss', trackedIds) : Promise.resolve([]),
  ])
  const { pending = 0, failed = 0 } = models.rows[0] ?? {}
  const activities: Activity[] = [
    {
      id: 'model-processing',
      kind: 'processing',
      state: pending ? 'running' : 'completed',
      label: pending
        ? `Processing ${pending} model${pending === 1 ? '' : 's'}…`
        : 'Model processing finished',
      href: '/models',
      count: pending,
      failures: failed,
    },
  ]
  if (includeOperations) {
    const returnedIds = new Set(jobs.map((job) => job.id))
    for (const id of trackedIds) {
      if (!returnedIds.has(id))
        activities.push({
          id,
          kind: 'scan',
          state: 'failed',
          label: 'Background task status is no longer available',
          href: '/admin/libraries',
        })
    }
  }
  if (!jobs.length) return activities

  const libraries = await db.execute<{ id: string; name: string }>(
    sql`SELECT id, name FROM libraries`,
  )
  const names = new Map(libraries.rows.map((library) => [library.id, library.name]))
  // A refused scan completes its queue job normally. Read its audit record so
  // an unmounted drive/mass disappearance cannot be announced as a success.
  const scans = await db.execute<{ library_id: string; started_at: Date; status: string }>(sql`
    SELECT library_id, started_at, status FROM scan_runs
    WHERE started_at >= ${new Date(Math.min(...jobs.map((job) => new Date(job.startedOn ?? job.createdOn).getTime())))}
    ORDER BY started_at DESC
  `)
  for (const job of jobs) {
    if (job.libraryId && !names.has(job.libraryId)) {
      if (trackedIds.includes(job.id))
        activities.push({
          id: job.id,
          kind: 'scan',
          state: 'failed',
          label: 'This task’s library is no longer available',
          href: '/admin/libraries',
        })
      continue
    }
    const kind = job.name === JOB.libraryScan ? 'scan' : 'health'
    let state: Activity['state'] =
      job.state === 'active'
        ? 'running'
        : job.state === 'created' || job.state === 'retry'
          ? 'queued'
          : job.state === 'completed'
            ? 'completed'
            : 'failed'
    if (kind === 'scan' && state === 'completed' && job.startedOn && job.completedOn) {
      const run = scans.rows.find(
        (scan) =>
          scan.library_id === job.libraryId &&
          new Date(scan.started_at) >= new Date(job.startedOn!) &&
          new Date(scan.started_at) <= new Date(job.completedOn!),
      )
      if (run && run.status !== 'succeeded') state = 'failed'
    }
    const target = job.libraryId ? `“${names.get(job.libraryId)}”` : 'libraries'
    const label =
      kind === 'scan'
        ? state === 'running'
          ? `Scanning ${target}…`
          : state === 'queued'
            ? `Scan queued for ${target}`
            : state === 'completed'
              ? `Scan finished for ${target}`
              : `Scan needs attention: ${target}`
        : state === 'running'
          ? `Checking health of ${target}…`
          : state === 'queued'
            ? `Health check queued for ${target}`
            : state === 'completed'
              ? `Health check finished for ${target}`
              : `Health check needs attention: ${target}`
    activities.push({
      id: job.id,
      kind,
      state,
      label,
      href: kind === 'scan' ? '/admin/libraries' : '/admin/health',
      createdAt: new Date(job.createdOn).toISOString(),
    })
  }
  return activities
}
