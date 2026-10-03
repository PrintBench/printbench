import { setTimeout as delay } from 'node:timers/promises'
import { sql } from 'drizzle-orm'
import type { Database } from '@pb/db'

/** A live lease is issued only while this process holds the database lock. */
export interface LibraryScanLock {
  readonly libraryId: string
}
const leases = new WeakMap<LibraryScanLock, Database>()

export function assertLibraryScanLock(lease: LibraryScanLock, db: Database, libraryId: string) {
  if (lease.libraryId !== libraryId || leases.get(lease) !== db) {
    throw new Error('A live library scan lock is required')
  }
}

/**
 * A scan and publication of imported files share one library-wide mutex across
 * worker processes. The lock connection holds no row changes: normal queries
 * still expose scan/import progress. Try-lock retries release their connection
 * while waiting, so competing scans cannot consume the entire database pool.
 */
export async function withLibraryScanLock<T>(
  db: Database,
  libraryId: string,
  work: (lease: LibraryScanLock) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  for (;;) {
    signal?.throwIfAborted()
    const result = await db.transaction(async (transaction) => {
      const locked = await transaction.execute<{ acquired: boolean }>(sql`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${'printbench:library-scan:' + libraryId}, 0)) AS acquired
      `)
      if (!locked.rows[0]?.acquired) return { acquired: false as const }
      signal?.throwIfAborted()
      const lease = Object.freeze({ libraryId })
      leases.set(lease, db)
      try {
        return { acquired: true as const, value: await work(lease) }
      } finally {
        leases.delete(lease)
      }
    })
    if (result.acquired) return result.value
    await delay(50, undefined, { signal })
  }
}
