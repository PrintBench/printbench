import type pg from 'pg'
import { readMigrationSteps, type MigrationStep } from '@pb/db/migrations'
import { BackupError, IDENTIFIER } from './manifest'

/**
 * Which tables a backup holds, and what a restore needs to know about them.
 *
 * Tables are discovered from the catalog rather than listed here, so a table
 * added by a later migration is backed up without anyone remembering to come
 * and add it. The exceptions are the short lists below.
 */

/**
 * Left out of every backup, and so empty after a restore.
 *
 * Sessions and verification tokens belong to browsers and emails that have no
 * business working against a different instance. Logs and process heartbeats
 * describe the machine the backup was taken on, not the data.
 */
export const EXCLUDED_TABLES = new Set(['session', 'verification', 'app_logs', 'process_status'])

/**
 * Columns encrypted under BETTER_AUTH_SECRET.
 *
 * They are written as NULL in the table data and carried separately,
 * re-encrypted under the backup passphrase — or not at all without one. A
 * column missing from this list would still be copied, as ciphertext only the
 * source instance can read; `tables.test.ts` checks the list against the
 * schema so that cannot happen quietly.
 */
export const SECRET_COLUMNS = [
  { table: 'libraries', column: 's3_secret_access_key', key: 'id' },
  { table: 'print_hosts', column: 'credentials', key: 'id' },
  { table: 'provider_credentials', column: 'makerworld_cookie_encrypted', key: 'user_id' },
  { table: 'provider_credentials', column: 'thingiverse_token_encrypted', key: 'user_id' },
] as const

export interface TableInfo {
  name: string
  columns: string[]
}

export function quoteIdent(name: string): string {
  if (!IDENTIFIER.test(name)) throw new BackupError(`Unexpected name in backup: ${name}`)
  return `"${name}"`
}

/** Every ordinary table in `public`, with the columns that can be written to. */
export async function listTables(client: pg.ClientBase): Promise<TableInfo[]> {
  const result = await client.query<{ name: string; columns: string[] }>(`
    SELECT c.relname::text AS name,
           array_agg(a.attname::text ORDER BY a.attnum) AS columns
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      -- Generated columns are computed on insert and cannot be supplied.
      AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
    GROUP BY c.relname
    ORDER BY c.relname`)
  return result.rows
}

export interface ForeignKey {
  table: string
  name: string
  definition: string
}

/**
 * Every foreign key in `public`, as the SQL that would recreate it.
 *
 * A restore drops these for the duration of the load and adds them back
 * afterwards. Loading parents before children is not an option: the schema
 * has cycles (a library names its last scan, and a scan names its library),
 * so no order satisfies them row by row. Adding a constraint back validates
 * every row against it, so nothing inconsistent survives the load.
 */
export async function listForeignKeys(client: pg.ClientBase): Promise<ForeignKey[]> {
  const result = await client.query<ForeignKey>(`
    SELECT rel.relname::text AS "table", con.conname::text AS name,
           pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE con.contype = 'f' AND n.nspname = 'public'
    ORDER BY rel.relname, con.conname`)
  return result.rows
}

/** The newest migration applied to this database, as a position in the journal. */
export async function currentMigration(
  client: pg.ClientBase,
  steps: MigrationStep[] = readMigrationSteps(),
): Promise<{ when: number; index: number }> {
  const result = await client.query<{ latest: string | null }>(
    'SELECT max(created_at)::text AS latest FROM drizzle.__drizzle_migrations',
  )
  const when = Number(result.rows[0]?.latest ?? NaN)
  const index = steps.findIndex((step) => step.when === when)
  if (index < 0) {
    throw new Error('This database is at a migration this build does not know about.')
  }
  return { when, index }
}
