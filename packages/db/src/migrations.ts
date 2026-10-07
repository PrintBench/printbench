import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type pg from 'pg'

/**
 * The migration history, readable as data.
 *
 * Restoring a backup has to rebuild the schema as it was when the backup was
 * taken, load the rows, and only then bring it forward — so it needs the
 * individual steps, not just "migrate to latest".
 *
 * Kept out of the package index on purpose: it probes the filesystem, and the
 * web bundle must not trace it.
 */
export const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
)

export interface MigrationStep {
  /** The journal timestamp. This is what drizzle compares to decide what is pending. */
  when: number
  hash: string
  statements: string[]
}

export function readMigrationSteps(): MigrationStep[] {
  return readMigrationFiles({ migrationsFolder }).map((step) => ({
    when: step.folderMillis,
    hash: step.hash,
    statements: step.sql,
  }))
}

/** Applies whatever is pending. The same call the entrypoint makes at startup. */
export async function applyMigrations(pool: pg.Pool): Promise<void> {
  await migrate(drizzle(pool), { migrationsFolder })
}
