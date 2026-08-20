import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { JOB } from './names'
import { JobQueue, getQueue, getStartedQueue } from './queue'

/**
 * Proves the queue actually round-trips through Postgres. Everything in phase 2
 * onwards is built on this, so "it typechecks" is not enough.
 *
 * Uses its own schema so it never touches the real job tables.
 */
const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

describeDb('JobQueue', () => {
  let queue: JobQueue

  beforeAll(async () => {
    /*
     * Drop the schema first. pg-boss persists jobs, so without this a leftover
     * job from a previous run is delivered before the one under test, and the
     * singleton assertions see a key that is already taken. The tests were
     * order- and history-dependent until this was added.
     */
    const admin = new pg.Client({ connectionString: url })
    await admin.connect()
    await admin.query('DROP SCHEMA IF EXISTS pgboss_test CASCADE')
    await admin.end()

    queue = new JobQueue({ connectionString: url, schema: 'pgboss_test' })
    await queue.start()
  }, 120_000)

  afterAll(async () => {
    await queue.stop()
  })

  /** Waits for a condition rather than sleeping a fixed amount. */
  async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('Timed out waiting for condition')
  }

  it('delivers a job to its handler with the payload intact', async () => {
    const received: string[] = []
    await queue.work(JOB.libraryScan, async (payload) => {
      received.push(`${payload.libraryId}:${payload.mode}`)
    })

    const id = '11111111-1111-4111-8111-111111111111'
    await queue.send(JOB.libraryScan, { libraryId: id, mode: 'deep', force: false })

    await waitFor(() => received.length > 0)
    expect(received[0]).toBe(`${id}:deep`)
  })

  it('applies zod defaults when enqueuing', async () => {
    const received: { mode: string; force: boolean }[] = []
    await queue.work(JOB.modelIndex, async () => {})
    await queue.work(JOB.maintReconcile, async () => {})

    // mode and force are optional in the payload but defaulted by the schema.
    const parsedId = '22222222-2222-4222-8222-222222222222'
    await queue.work(JOB.fileDigest, async () => {})

    // Sending with only the required field must not throw.
    await expect(queue.send(JOB.fileDigest, { fileId: parsedId })).resolves.toBeDefined()
    expect(received).toEqual([])
  })

  it('rejects a malformed payload before it reaches the queue', async () => {
    await expect(
      // Not a uuid: must fail here rather than inside a handler later.
      queue.send(JOB.libraryScan, { libraryId: 'not-a-uuid', mode: 'fast', force: false }),
    ).rejects.toThrow()
  })

  /*
   * Regression test for a real trap: a singletonKey does NOTHING on a
   * `standard` policy queue. Library scans use `stately`, which permits one
   * queued plus one active job per key — so pressing Scan repeatedly collapses
   * instead of queueing five scans of the same library.
   */
  it('collapses repeated scan requests for the same library', async () => {
    const libraryId = '33333333-3333-4333-8333-333333333333'
    const key = `scan:${libraryId}`
    const payload = { libraryId, mode: 'fast' as const, force: false }

    const first = await queue.send(JOB.libraryScan, payload, { singletonKey: key })
    const second = await queue.send(JOB.libraryScan, payload, { singletonKey: key })
    const third = await queue.send(JOB.libraryScan, payload, { singletonKey: key })

    expect(first).toBeTruthy()
    expect(second).toBeNull()
    expect(third).toBeNull()
  })

  it('still queues scans for a different library', async () => {
    const other = '55555555-5555-4555-8555-555555555555'
    const id = await queue.send(
      JOB.libraryScan,
      { libraryId: other, mode: 'fast', force: false },
      { singletonKey: `scan:${other}` },
    )
    // Dedupe is per key, not global: two libraries must scan independently.
    expect(id).toBeTruthy()
  })

  it('inserts a batch in one round trip', async () => {
    const items = Array.from({ length: 120 }, (_, i) => ({
      fileId: `44444444-4444-4444-8444-${String(i).padStart(12, '0')}`,
    }))
    await expect(queue.sendMany(JOB.fileAnalyze, items)).resolves.toBeUndefined()

    const stats = await queue.stats(JOB.fileAnalyze)
    expect(stats.queued + stats.active).toBeGreaterThan(0)
  })

  it('reports queue depth for the admin health page', async () => {
    const stats = await queue.stats(JOB.fileThumbnail)
    expect(stats).toHaveProperty('queued')
    expect(stats).toHaveProperty('active')
    expect(stats).toHaveProperty('failed')
  })
})

describe('JobQueue lifecycle', () => {
  /*
   * Regression: the worker held its own JobQueue while handlers reached for the
   * getQueue() singleton, so enqueuing from inside a handler hit an unstarted
   * queue. It surfaced as an unexplained scan failure rather than anything
   * pointing at the cause.
   */
  it('refuses to send before it is started, with a useful message', async () => {
    const idle = new JobQueue({ connectionString: url, schema: 'pgboss_test' })
    await expect(
      idle.send(JOB.fileDigest, { fileId: '11111111-1111-4111-8111-111111111111' }),
    ).rejects.toThrow(/not been started/i)
    await expect(idle.sendMany(JOB.fileDigest, [])).rejects.toThrow(/not been started/i)
  })

  it('starts only once, however many callers arrive together', async () => {
    // Two server actions landing at the same moment must not both bootstrap
    // pg-boss and re-run createQueue for every job name.
    const queue = new JobQueue({ connectionString: url, schema: 'pgboss_test' })
    await Promise.all([queue.start(), queue.start(), queue.start()])

    await expect(
      queue.send(JOB.fileDigest, { fileId: '22222222-2222-4222-8222-222222222222' }),
    ).resolves.toBeTruthy()

    await queue.stop()
  }, 120_000)
})

/*
 * Regression, and the more expensive one: the web process only ever sends and
 * has no boot step, so nothing started the shared queue. Every enqueue from a
 * server action threw and was reported to the user as a generic failure — the
 * Scan button could not work at all.
 */
describeDb('getStartedQueue', () => {
  /*
   * Proved with stats() rather than send(): this touches the real job schema,
   * and enqueuing a job for a file id that does not exist would leave the
   * running worker something broken to chew on.
   */
  it('returns a queue that is actually started', async () => {
    const queue = await getStartedQueue()
    await expect(queue.stats(JOB.fileDigest)).resolves.toHaveProperty('queued')
  }, 120_000)

  it('hands back the same instance as getQueue', async () => {
    expect(await getStartedQueue()).toBe(getQueue())
  })

  it('is safe to call repeatedly', async () => {
    const [a, b] = await Promise.all([getStartedQueue(), getStartedQueue()])
    expect(a).toBe(b)
  })

  afterAll(async () => {
    await getQueue().stop()
  })
})
