import 'server-only'
import { sql } from 'drizzle-orm'
import { getDb } from '@pb/db'

/**
 * True when the instance has no users at all.
 *
 * Gates the /setup route: the very first account must become an admin, but
 * that route has to close permanently the moment one exists, or anyone could
 * claim admin on a public instance.
 */
export async function needsFirstRunSetup(): Promise<boolean> {
  const result = await getDb().execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM "user"`)
  return (result.rows[0]?.n ?? 0) === 0
}

export async function userCount(): Promise<number> {
  const result = await getDb().execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM "user"`)
  return result.rows[0]?.n ?? 0
}
