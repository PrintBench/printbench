import 'server-only'
import { sql } from 'drizzle-orm'
import { isDemoMode } from '@pb/core'
import { getDb } from '@pb/db'

/**
 * True when the instance has no users at all.
 *
 * Gates the /setup route: the very first account must become an admin, but
 * that route has to close permanently the moment one exists, or anyone could
 * claim admin on a public instance.
 */
export async function needsFirstRunSetup(): Promise<boolean> {
  /*
   * A demo instance is never set up by a visitor: the worker's nightly reset
   * creates the shared account in the same transaction that rebuilds the
   * schema. Saying no here as well means that, if a reset ever did leave the
   * table empty, a stranger still could not claim admin or restore a backup.
   */
  if (isDemoMode()) return false
  const result = await getDb().execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM "user"`)
  return (result.rows[0]?.n ?? 0) === 0
}

export async function userCount(): Promise<number> {
  const result = await getDb().execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM "user"`)
  return result.rows[0]?.n ?? 0
}
