import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type pg from 'pg'
import { sql } from 'drizzle-orm'
import { hashAccountPassword } from '@pb/auth/password-hash'
import { demoConfig, demoLibraryPath, demoResetOverdue, demoUploadsPath } from '@pb/core'
import { readMigrationSteps } from '@pb/db/migrations'
import type { Database } from '@pb/db'
import { replayMigrations } from '../backup/restore'
import { handleLibraryScan } from '../jobs/scan'
import { seedDemo } from './seed'

/**
 * Puts a demo instance back to its shop window.
 *
 * The order matters, and each step is there for a reason:
 *
 * 1. Work is paused, as for a restore, so no job writes into tables about to
 *    vanish.
 * 2. Files visitors added are deleted before the database forgets them.
 * 3. The schema is rebuilt AND the shared account created in ONE transaction.
 *    Postgres DDL is transactional, so the web tier sees the old database
 *    until the commit and the new one, already holding a user, afterwards.
 *    There is never a moment with zero users, which is the moment the
 *    unauthenticated first-run setup would let a stranger claim admin.
 * 4. Work resumes before the scan, not after: resuming discards pending jobs,
 *    which would otherwise throw away the thumbnails the scan queues.
 * 5. The scan reads the library's sidecars; the seed adds the rest.
 */

export interface DemoResetDeps {
  db: Database
  pool: pg.Pool
  dataDir: string
  pauseWork: () => Promise<void>
  resumeWork: (options: { restored: boolean }) => Promise<void>
  /**
   * Scans the demo library. Defaults to the ordinary scan job, which also
   * queues thumbnails; tests pass one bound to their scratch database.
   */
  scan?: (libraryId: string) => Promise<void>
}

export interface DemoResetResult {
  userId: string
  libraryId: string
  seconds: number
}

/** DATA_DIR children the app writes into. Anything else there is left alone. */
const WRITABLE_DATA = ['libraries', 'photos', 'uploads', 'previews', 'backups']

export async function resetDemo(
  deps: DemoResetDeps,
  options: { paused?: boolean } = {},
): Promise<DemoResetResult> {
  const started = Date.now()
  const config = demoConfig()
  console.log('[demo] resetting to the shop window')

  if (!options.paused) await deps.pauseWork()

  let resumed = false
  try {
    await clearWrittenData(deps.dataDir)
    const { userId, libraryId } = await rebuildDatabase(deps.pool, config)
    await mkdir(demoUploadsPath(), { recursive: true })

    await deps.resumeWork({ restored: true })
    resumed = true

    const scan =
      deps.scan ??
      ((id: string) => handleLibraryScan({ libraryId: id, mode: 'deep', force: false }))
    await scan(libraryId)
    await seedDemo(deps.db, userId)

    const seconds = Math.round((Date.now() - started) / 100) / 10
    console.log(`[demo] reset complete in ${seconds}s`)
    return { userId, libraryId, seconds }
  } catch (error) {
    // Whatever failed, the worker must not be left paused for the rest of the day.
    console.error('[demo] reset failed:', error)
    if (!resumed) await deps.resumeWork({ restored: true }).catch(() => undefined)
    throw error
  }
}

/** True when there is no demo account yet, or the last reset is older than the schedule allows. */
export async function demoNeedsReset(db: Database, now = new Date()): Promise<boolean> {
  try {
    const rows = await db.execute<{ created_at: Date }>(
      sql`SELECT created_at FROM "user" WHERE email = ${demoConfig().email.toLowerCase()} LIMIT 1`,
    )
    const seededAt = rows.rows[0]?.created_at
    return !seededAt || demoResetOverdue(new Date(seededAt), now)
  } catch {
    // No user table at all is the emptiest database there is.
    return true
  }
}

async function clearWrittenData(dataDir: string): Promise<void> {
  for (const name of WRITABLE_DATA) {
    const dir = path.join(dataDir, name)
    const entries = await readdir(dir).catch(() => [] as string[])
    // Empty the folder rather than removing it: nginx and the worker hold it as a mount point.
    for (const entry of entries) await rm(path.join(dir, entry), { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
  }
}

async function rebuildDatabase(
  pool: pg.Pool,
  config: ReturnType<typeof demoConfig>,
): Promise<{ userId: string; libraryId: string }> {
  const steps = readMigrationSteps()
  const passwordHash = await hashAccountPassword(config.password)
  const userId = randomUUID()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // The web tier keeps serving. Wait for its queries, but not forever.
    await client.query("SET LOCAL lock_timeout = '30s'")
    await client.query('DROP SCHEMA IF EXISTS public CASCADE')
    await client.query('DROP SCHEMA IF EXISTS drizzle CASCADE')
    await client.query('CREATE SCHEMA public')
    await replayMigrations(client, steps)

    // An admin, so the admin pages can be shown off; can() fences off the dangerous ones.
    await client.query(
      `INSERT INTO "user" (id, name, email, email_verified, role) VALUES ($1, $2, $3, true, 'admin')`,
      [userId, config.name, config.email.toLowerCase()],
    )
    await client.query(
      `INSERT INTO account (id, account_id, provider_id, user_id, password)
       VALUES ($1, $2, 'credential', $2, $3)`,
      [randomUUID(), userId, passwordHash],
    )

    const library = await client.query<{ id: string }>(
      `INSERT INTO libraries (name, path, kind, backend, allow_writes, grouping_mode, write_sidecar)
       VALUES ('Demo library', $1, 'in_place', 'local', false, 'deepest', false)
       RETURNING id`,
      [demoLibraryPath()],
    )
    await client.query(
      `INSERT INTO libraries (name, path, kind, backend, allow_writes, grouping_mode, write_sidecar)
       VALUES ('Your uploads', $1, 'managed', 'local', true, 'deepest', false)`,
      [demoUploadsPath()],
    )

    await client.query('COMMIT')
    return { userId, libraryId: library.rows[0]!.id }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
