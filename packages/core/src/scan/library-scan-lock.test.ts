import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { createDb } from '@pb/db'
import {
  assertLibraryScanLock,
  withLibraryScanLock,
  type LibraryScanLock,
} from './library-scan-lock'

describe('library scan publication lease', { tags: ['integration'] }, () => {
  let first: ReturnType<typeof createDb>
  let second: ReturnType<typeof createDb>
  beforeAll(() => {
    first = createDb()
    second = createDb()
  })
  afterAll(async () => {
    await first.pool.end()
    await second.pool.end()
  })

  it('rejects forged, wrong-library and expired leases', async () => {
    const id = randomUUID()
    expect(() => assertLibraryScanLock({ libraryId: id }, first.db, id)).toThrow('live')
    let held: LibraryScanLock | undefined
    await withLibraryScanLock(first.db, id, async (lease) => {
      held = lease
      expect(() => assertLibraryScanLock(lease, first.db, id)).not.toThrow()
      expect(() => assertLibraryScanLock(lease, first.db, randomUUID())).toThrow('live')
      expect(() => assertLibraryScanLock(lease, second.db, id)).toThrow('live')
    })
    expect(() => assertLibraryScanLock(held!, first.db, id)).toThrow('live')
  })

  it('releases a failed publication lease for a later scan', async () => {
    const id = randomUUID()
    await expect(
      withLibraryScanLock(first.db, id, async () => {
        throw new Error('publication failed')
      }),
    ).rejects.toThrow('publication failed')
    expect(await withLibraryScanLock(second.db, id, async () => 'recovered')).toBe('recovered')
  })

  it('cancels a competing scan without retaining a connection or disturbing the active lease', async () => {
    const id = randomUUID()
    let entered!: () => void
    let release!: () => void
    let tried!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const attempted = new Promise<void>((resolve) => {
      tried = resolve
    })
    const original = second.db.transaction.bind(second.db)
    const transaction = vi.spyOn(second.db, 'transaction').mockImplementation((callback, config) =>
      original(async (tx) => {
        const execute = tx.execute.bind(tx)
        tx.execute = ((query: Parameters<typeof tx.execute>[0]) =>
          execute(query).then((result) => {
            if ((result.rows[0] as { acquired?: boolean } | undefined)?.acquired === false) tried()
            return result
          })) as typeof tx.execute
        return callback(tx)
      }, config),
    )
    const active = withLibraryScanLock(first.db, id, async (lease) => {
      entered()
      await held
      assertLibraryScanLock(lease, first.db, id)
    })
    const abort = new AbortController()
    let waiting: Promise<string> | undefined
    try {
      await started
      waiting = withLibraryScanLock(second.db, id, async () => 'unexpected', abort.signal)
      const rejected = expect(waiting).rejects.toThrow()
      await attempted
      abort.abort()
      await rejected
      // A waiting lock used try-lock, so its connection is available for an
      // unrelated query even while the other worker still owns the library.
      expect((await second.db.execute<{ one: number }>(sql`SELECT 1 AS one`)).rows[0]?.one).toBe(1)
      expect(second.pool.waitingCount).toBe(0)
      release()
      await active
      expect(await withLibraryScanLock(second.db, id, async () => 'next scan')).toBe('next scan')
    } finally {
      abort.abort()
      release()
      await active
      await waiting?.catch(() => undefined)
      transaction.mockRestore()
    }
  })
})
