import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDb } from '@pb/db'
import { activityJobs, JOB, JobQueue } from '@pb/jobs'
import { readActivity } from './activity'

const LIBRARY = 'ac710000-0000-4000-8000-000000000001'
const MODEL = 'ac710000-0000-4000-8000-000000000002'
const FILE = 'ac710000-0000-4000-8000-000000000003'

describe('activity database snapshot', { tags: ['integration'] }, () => {
  let database: ReturnType<typeof createDb>
  let queue: JobQueue
  const jobIds: string[] = []
  const queueDb = {
    executeSql: (query: string, values?: unknown[]) => database.pool.query(query, values),
  }
  beforeAll(async () => {
    database = createDb()
    queue = new JobQueue()
    await queue.start()
  }, 120000)
  beforeEach(async () => {
    await database.db.execute(sql`DELETE FROM libraries WHERE id = ${LIBRARY}`)
    await database.db.execute(sql`INSERT INTO libraries (id, name, kind, backend, path)
      VALUES (${LIBRARY}, 'Activity fixture', 'managed', 'local', '/fixtures/activity')`)
    await database.db.execute(sql`INSERT INTO models (id, library_id, path, name, slug, public_id)
      VALUES (${MODEL}, ${LIBRARY}, 'model', 'Model', 'activity-fixture', 'activity-fixture')`)
    await database.db
      .execute(sql`INSERT INTO model_files (id, model_id, filename, extension, category, previewable)
      VALUES (${FILE}, ${MODEL}, 'model.stl', 'stl', 'model', true)`)
  })
  afterAll(async () => {
    for (const id of jobIds) await database.pool.query('DELETE FROM pgboss.job WHERE id = $1', [id])
    await database.db.execute(sql`DELETE FROM libraries WHERE id = ${LIBRARY}`)
    await queue.stop()
    await database.pool.end()
  })

  it('counts pending models, ignores unsupported/missing files, and settles failures', async () => {
    const forbiddenQueueRead = {
      executeSql: vi.fn().mockRejectedValue(new Error('Must not read operations')),
    }
    const read = () => readActivity(database.db, forbiddenQueueRead, false)
    expect((await read())[0]).toMatchObject({ state: 'running', count: 1 })
    await database.db.execute(sql`UPDATE model_files SET previewable = false WHERE id = ${FILE}`)
    expect((await read())[0]).toMatchObject({ state: 'completed', count: 0 })
    await database.db.execute(
      sql`UPDATE model_files SET previewable = true, thumb_state = 'failed' WHERE id = ${FILE}`,
    )
    expect((await read())[0]).toMatchObject({ state: 'completed', count: 0, failures: 1 })
    await database.db.execute(sql`UPDATE model_files SET missing_at = now() WHERE id = ${FILE}`)
    expect((await read())[0]).toMatchObject({ count: 0, failures: 0 })
    expect(forbiddenQueueRead.executeSql).not.toHaveBeenCalled()
  })

  it('tolerates an instance where the worker has not initialized its schema', async () => {
    expect(await activityJobs(queueDb, 'activity_uninitialized_fixture')).toEqual([])
  })

  it('reports queued/running health checks and their real terminal states', async () => {
    const id = (await queue.send(JOB.healthDetect, { libraryId: LIBRARY, skipCosmetic: false }))!
    jobIds.push(id)
    const read = async () =>
      (await readActivity(database.db, queueDb, true)).find((row) => row.id === id)
    expect(await read()).toMatchObject({ kind: 'health', state: 'queued', href: '/admin/health' })
    await database.pool.query(
      "UPDATE pgboss.job SET state = 'active', started_on = now() WHERE id = $1",
      [id],
    )
    expect(await read()).toMatchObject({ state: 'running' })
    await database.pool.query(
      "UPDATE pgboss.job SET state = 'failed', completed_on = now() WHERE id = $1",
      [id],
    )
    expect(await read()).toMatchObject({ state: 'failed' })
    await database.pool.query("UPDATE pgboss.job SET state = 'completed' WHERE id = $1", [id])
    expect(await read()).toMatchObject({ state: 'completed' })
    expect(await read()).not.toHaveProperty('data')
    await database.pool.query(
      "UPDATE pgboss.job SET completed_on = now() - interval '10 minutes' WHERE id = $1",
      [id],
    )
    expect(await read()).toBeUndefined()
    expect(
      (await readActivity(database.db, queueDb, true, [id])).find((row) => row.id === id),
    ).toMatchObject({ state: 'completed' })
  })

  it('reports expired tracked records as unavailable instead of claiming success', async () => {
    const id = 'ac710000-0000-4000-8000-000000000099'
    expect(
      (await readActivity(database.db, queueDb, true, [id])).find((row) => row.id === id),
    ).toMatchObject({ state: 'failed', label: 'Background task status is no longer available' })
  })

  it('reports a refused scan as needing attention even though its queue job completed', async () => {
    const id = (await queue.send(JOB.libraryScan, {
      libraryId: LIBRARY,
      mode: 'fast',
      force: false,
    }))!
    jobIds.push(id)
    await database.pool.query(
      "UPDATE pgboss.job SET state = 'completed', started_on = now() - interval '5 seconds', completed_on = now() WHERE id = $1",
      [id],
    )
    await database.db
      .execute(sql`INSERT INTO scan_runs (library_id, status, mode, started_at, finished_at)
      VALUES (${LIBRARY}, 'aborted', 'fast', now() - interval '4 seconds', now())`)
    expect(
      (await readActivity(database.db, queueDb, true)).find((row) => row.id === id),
    ).toMatchObject({ state: 'failed', kind: 'scan', href: '/admin/libraries' })
  })
})
