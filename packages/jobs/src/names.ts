import { z } from 'zod'

/**
 * Job names and payload shapes.
 *
 * Payloads carry ids only, never data. Handlers re-read current state from the
 * database, which is what makes a replayed or duplicated job harmless — and
 * pg-boss, like every at-least-once queue, will occasionally deliver twice.
 */

export const JOB = {
  libraryScan: 'library.scan',
  modelIndex: 'model.index',
  modelMove: 'model.move',
  fileDigest: 'file.digest',
  fileAnalyze: 'file.analyze',
  fileThumbnail: 'file.thumbnail',
  searchRefresh: 'search.refresh',
  healthDetect: 'health.detect',
  scheduleSweep: 'library.schedule',
  maintReconcile: 'maint.reconcile',
  maintArchive: 'maint.archive',
} as const

export type JobName = (typeof JOB)[keyof typeof JOB]

export const payloads = {
  [JOB.libraryScan]: z.object({
    libraryId: z.string().uuid(),
    mode: z.enum(['fast', 'deep']).default('fast'),
    /** Set only when an admin has confirmed a genuine mass deletion. */
    force: z.boolean().default(false),
  }),
  [JOB.modelIndex]: z.object({ modelId: z.string().uuid() }),
  [JOB.modelMove]: z.object({
    modelId: z.string().uuid(),
    destinationLibraryId: z.string().uuid(),
    /** Absent means keep the path it already had. */
    destinationPath: z.string().max(1000).optional(),
  }),
  [JOB.fileDigest]: z.object({ fileId: z.string().uuid() }),
  [JOB.fileAnalyze]: z.object({ fileId: z.string().uuid() }),
  [JOB.fileThumbnail]: z.object({ fileId: z.string().uuid() }),
  [JOB.searchRefresh]: z.object({ modelIds: z.array(z.string().uuid()).max(1000) }),
  [JOB.healthDetect]: z
    .object({
      /** Absent means every library. */
      libraryId: z.string().uuid().optional(),
      skipCosmetic: z.boolean().default(false),
    })
    .default({ skipCosmetic: false }),
  [JOB.scheduleSweep]: z.object({}).default({}),
  [JOB.maintReconcile]: z.object({}).default({}),
  [JOB.maintArchive]: z.object({}).default({}),
} as const

export type JobPayload<N extends JobName> = z.infer<(typeof payloads)[N]>

/**
 * Per-queue policy and priority.
 *
 * `policy` matters more than it looks. A `singletonKey` on its own does NOT
 * deduplicate — verified against pg-boss 12 — so a `standard` queue happily
 * accepts five identical scan requests. The policies:
 *
 *   standard  no dedupe
 *   short     at most one QUEUED job per key
 *   singleton at most one ACTIVE job per key
 *   stately   at most one per state: one queued AND one active
 *
 * Library scans use `stately`, which gives the behaviour a user expects from
 * pressing a Scan button repeatedly: the running scan finishes, exactly one
 * more is queued behind it, and the rest collapse.
 *
 * Per-file jobs stay `standard`. Their handlers are idempotent and re-read
 * state, so a duplicate wastes a little work but cannot corrupt anything, and
 * the reconcile sweep depends on being able to re-enqueue freely.
 */
export type QueuePolicy = 'standard' | 'short' | 'singleton' | 'stately'

export const JOB_OPTIONS: Record<
  JobName,
  { concurrency: number; priority?: number; policy: QueuePolicy }
> = {
  [JOB.libraryScan]: { concurrency: 1, priority: 10, policy: 'stately' },
  [JOB.modelIndex]: { concurrency: 4, priority: 8, policy: 'standard' },
  /*
   * One move at a time, and the highest priority of anything here.
   *
   * Serial because two concurrent moves into the same library can each check
   * a free destination path and then both take it. Highest because a move is
   * the only job in this list a person is sitting and waiting for — everything
   * else fills in behind a page that already renders.
   *
   * `stately` rather than `standard`: a replayed move is not harmless the way
   * a replayed render is. The second run finds the files gone from the source
   * and fails, which is safe but reports a failure for a move that worked.
   */
  [JOB.modelMove]: { concurrency: 1, priority: 12, policy: 'stately' },
  // Analysis is cheap and drives visible badges, so it outranks thumbnails.
  [JOB.fileAnalyze]: { concurrency: 2, priority: 6, policy: 'standard' },
  [JOB.fileThumbnail]: { concurrency: 2, priority: 4, policy: 'standard' },
  // Digests only feed dedupe and rename detection; they can wait.
  [JOB.fileDigest]: { concurrency: 4, priority: 2, policy: 'standard' },
  [JOB.searchRefresh]: { concurrency: 2, priority: 7, policy: 'standard' },
  /*
   * Lowest priority and one at a time. Health detection runs nine full-table
   * statements, so two concurrent passes would contend for the same rows to
   * produce the same answer — and nothing user-facing is waiting on it.
   */
  [JOB.healthDetect]: { concurrency: 1, priority: 1, policy: 'stately' },
  /*
   * One sweep at a time. Two concurrent sweeps would both see the same library
   * as due and enqueue it twice — harmless, because library.scan is `stately`
   * and collapses them, but pointless work.
   */
  [JOB.scheduleSweep]: { concurrency: 1, policy: 'stately' },
  // Only ever one maintenance sweep in flight.
  [JOB.maintReconcile]: { concurrency: 1, policy: 'stately' },
  [JOB.maintArchive]: { concurrency: 1, policy: 'stately' },
}
