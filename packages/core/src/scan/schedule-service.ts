import { sql } from 'drizzle-orm'
import type { Database } from '@pb/db'
import { isScanDue } from './schedule-presets'

export * from './schedule-presets'

export interface DueLibrary {
  id: string
  name: string
  cron: string
  lastScanAt: Date | null
}

/**
 * Libraries whose schedule has come round.
 *
 * The last scan time is the last one that actually *started*, including aborted
 * ones. Using only successful scans would make an aborted library — an
 * unmounted drive — retry on every single sweep.
 */
export async function librariesDue(db: Database, now: Date = new Date()): Promise<DueLibrary[]> {
  const rows = await db.execute<{
    id: string
    name: string
    scan_cron: string | null
    last_scan_at: string | null
  }>(sql`
    SELECT l.id, l.name, l.scan_cron,
           (SELECT max(coalesce(s.started_at, s.created_at))
              FROM scan_runs s WHERE s.library_id = l.id) AS last_scan_at
    FROM libraries l
    WHERE l.scan_enabled AND l.scan_cron IS NOT NULL AND l.scan_cron <> ''`)

  return rows.rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      cron: row.scan_cron!,
      lastScanAt: row.last_scan_at ? new Date(row.last_scan_at) : null,
    }))
    .filter((library) => isScanDue(library.cron, library.lastScanAt, now))
}
