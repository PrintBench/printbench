import { PgBoss } from 'pg-boss'
import { JOB, JOB_OPTIONS, payloads, type JobName, type JobPayload } from './names'

/**
 * Job queue, backed by Postgres via pg-boss.
 *
 * Wrapped so nothing else imports pg-boss directly: a breaking change upstream
 * stays contained here, and swapping to another Postgres-backed queue would be
 * a day's work rather than a rewrite.
 *
 * Postgres rather than Redis is the whole point — one piece of infrastructure
 * to run and back up, not two.
 */

export interface QueueOptions {
  connectionString?: string
  schema?: string
}

export type JobHandler<N extends JobName> = (payload: JobPayload<N>) => Promise<void>

export class JobQueue {
  private boss: PgBoss
  private started = false

  constructor(options: QueueOptions = {}) {
    const connectionString = options.connectionString ?? process.env.DATABASE_URL
    if (!connectionString) throw new Error('DATABASE_URL is not set')

    this.boss = new PgBoss({
      connectionString,
      schema: options.schema ?? 'pgboss',
      // Warn before the job table becomes a problem nobody is watching for.
      warningQueueSize: 10_000,
    })

    this.boss.on('error', (error: unknown) => {
      console.error('[queue] pg-boss error:', error)
    })
  }

  async start(): Promise<void> {
    if (this.started) return
    await this.boss.start()
    /*
     * Queues must exist before work can be sent to them.
     *
     * Retention is set explicitly per queue rather than left to defaults: a
     * self-hosted instance runs for years and nobody performs maintenance on
     * it, so an unbounded job table is a real failure mode.
     */
    for (const name of Object.values(JOB)) {
      await this.boss.createQueue(name, {
        // Dedupe behaviour. A singletonKey alone does nothing on a standard
        // queue; see the note in names.ts.
        policy: JOB_OPTIONS[name].policy,
        deleteAfterSeconds: 60 * 60 * 12, // completed jobs kept half a day
        retentionSeconds: 60 * 60 * 24 * 3, // unstarted jobs expire after 3 days
        expireInSeconds: 60 * 60 * 2, // a job stuck active for 2h is retried
        retryLimit: 3,
        retryDelay: 30,
        retryBackoff: true,
      })
    }
    this.started = true
  }

  async stop(): Promise<void> {
    if (!this.started) return
    // Let in-flight jobs finish: a scan killed mid-write leaves a partial index.
    await this.boss.stop({ graceful: true, timeout: 30_000 })
    this.started = false
  }

  /**
   * Enqueues a job.
   *
   * `singletonKey` collapses duplicates, so pressing "Scan" three times while a
   * scan is queued does not run three scans.
   */
  async send<N extends JobName>(
    name: N,
    payload: JobPayload<N>,
    options: { singletonKey?: string; startAfterSeconds?: number } = {},
  ): Promise<string | null> {
    const parsed = payloads[name].parse(payload)
    return this.boss.send(name, parsed as object, {
      priority: JOB_OPTIONS[name].priority ?? 0,
      ...(options.singletonKey ? { singletonKey: options.singletonKey } : {}),
      ...(options.startAfterSeconds ? { startAfter: options.startAfterSeconds } : {}),
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 60 * 60 * 6,
    })
  }

  /** Batched insert. A 50k-file library sends ~100 statements, not 50k. */
  async sendMany<N extends JobName>(name: N, items: JobPayload<N>[]): Promise<void> {
    const CHUNK = 500
    for (let i = 0; i < items.length; i += CHUNK) {
      const batch = items.slice(i, i + CHUNK).map((payload) => ({
        data: payloads[name].parse(payload) as object,
        priority: JOB_OPTIONS[name].priority ?? 0,
        retryLimit: 3,
        retryDelay: 30,
      }))
      await this.boss.insert(name, batch)
    }
  }

  async work<N extends JobName>(name: N, handler: JobHandler<N>): Promise<string> {
    return this.boss.work<object>(
      name,
      { batchSize: 1, pollingIntervalSeconds: 2 },
      async (jobs) => {
        for (const job of jobs) {
          // Validate on the way in: a payload written by an older version of
          // the app must fail loudly here rather than midway through a handler.
          const payload = payloads[name].parse(job.data) as JobPayload<N>
          await handler(payload)
        }
      },
    )
  }

  /** Registers a cron schedule. Safe to call repeatedly; it upserts. */
  async schedule<N extends JobName>(name: N, cron: string, payload: JobPayload<N>): Promise<void> {
    await this.boss.schedule(name, cron, payloads[name].parse(payload) as object)
  }

  /** Queue depth by state, for the admin health page. */
  async stats(name: JobName): Promise<{ queued: number; active: number; failed: number }> {
    const [snapshot] = await this.boss.getQueueStats(name)
    return {
      queued: snapshot?.queuedCount ?? 0,
      active: snapshot?.activeCount ?? 0,
      failed: snapshot?.failedCount ?? 0,
    }
  }
}

let shared: JobQueue | undefined

/** Process-wide queue. Both web (send) and worker (work) use one instance. */
export function getQueue(): JobQueue {
  shared ??= new JobQueue()
  return shared
}
