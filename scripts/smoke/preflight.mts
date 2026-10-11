import { sql } from 'drizzle-orm'
import { createDb } from '@pb/db'

const { db, pool } = createDb()
try {
  const result = await db.execute<{ users: number; libraries: number }>(sql`
    SELECT (SELECT count(*)::int FROM "user") AS users,
           (SELECT count(*)::int FROM libraries) AS libraries`)
  if (result.rows[0]?.users !== 0 || result.rows[0]?.libraries !== 0) {
    throw new Error(
      'Smoke tests refuse an existing instance. Use an empty, migrated test database.',
    )
  }
} finally {
  await pool.end()
}
