/**
 * Applies pending SQL migrations, then exits. Run by the Docker entrypoint
 * before the app starts, and by `npm run db:migrate` in development.
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { createDb } from './client'

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

const { pool, db } = createDb()

try {
  console.log(`[migrate] applying migrations from ${migrationsFolder}`)
  await migrate(db, { migrationsFolder })
  console.log('[migrate] up to date')
} catch (error) {
  console.error('[migrate] failed:', error)
  process.exitCode = 1
} finally {
  await pool.end()
}
