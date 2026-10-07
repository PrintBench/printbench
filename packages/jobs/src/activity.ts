import type { Db as IDatabase } from 'pg-boss'
import { JOB } from './names'

export interface ActivityJob {
  id: string
  name: typeof JOB.libraryScan | typeof JOB.healthDetect
  state: 'created' | 'retry' | 'active' | 'completed' | 'cancelled' | 'failed'
  libraryId: string | null
  startedOn: Date | null
  createdOn: Date
  completedOn: Date | null
}

/** Read activity without bootstrapping the queue or exposing its payloads/errors. */
export async function activityJobs(
  db: IDatabase,
  schema = 'pgboss',
  trackedIds: string[] = [],
): Promise<ActivityJob[]> {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error('Invalid queue schema')
  const exists = await db.executeSql('SELECT to_regclass($1) AS table_name', [`${schema}.job`])
  if (!exists.rows[0]?.table_name) return []
  const result = await db.executeSql(
    `SELECT id, name, state, data->>'libraryId' AS "libraryId",
            started_on AS "startedOn", created_on AS "createdOn", completed_on AS "completedOn"
     FROM "${schema}".job
     WHERE name = ANY($1::text[])
       AND (state IN ('created', 'retry', 'active') OR completed_on > now() - interval '5 minutes'
            OR id = ANY($2::uuid[]))
     ORDER BY created_on, id`,
    [[JOB.libraryScan, JOB.healthDetect], trackedIds],
  )
  return result.rows as ActivityJob[]
}
