import path from 'node:path'
import { CronExpressionParser } from 'cron-parser'
import { managedRoot } from '../library/roots'
import { demoConfig, isDemoMode } from './demo'

/**
 * Server-side half of the demo switch: anything needing Node or cron-parser,
 * kept out of ./demo so the browser bundle of the policy stays small.
 */

/**
 * The next demo reset after `after`.
 *
 * Always UTC, whatever TZ the container has: the banner promises "midnight
 * UTC" and a reset that drifted with the host's clock would make it a lie.
 * An unparseable cron falls back to the default rather than never resetting,
 * because a demo that silently stops resetting is the failure nobody notices.
 */
export function nextDemoReset(after: Date = new Date(), cron = demoConfig().resetCron): Date {
  try {
    return CronExpressionParser.parse(cron, { currentDate: after, tz: 'UTC' }).next().toDate()
  } catch {
    return CronExpressionParser.parse('0 0 * * *', { currentDate: after, tz: 'UTC' })
      .next()
      .toDate()
  }
}

/**
 * Whether a demo seeded at `seededAt` has missed a reset by `now`.
 *
 * Used at worker boot, so a server that was down at midnight still catches up
 * instead of serving yesterday's visitors' changes all day.
 */
export function demoResetOverdue(seededAt: Date, now: Date = new Date(), cron?: string): boolean {
  return nextDemoReset(seededAt, cron).getTime() <= now.getTime()
}

/** The read-only shop-window library, as stored on its row. */
export function demoLibraryPath(): string {
  return path.resolve(demoConfig().libraryPath)
}

/** The managed library the reset creates so the Upload page has somewhere to write. */
export function demoUploadsPath(): string {
  return path.join(managedRoot(), 'demo-uploads')
}

/**
 * True for the two libraries the reset creates.
 *
 * Visitors may add and remove their own libraries, but renaming, rescheduling
 * or removing these would break the demo for everyone else until midnight.
 */
export function isDemoSeededLibrary(libraryPath: string | null | undefined): boolean {
  if (!isDemoMode() || !libraryPath) return false
  const resolved = path.resolve(libraryPath)
  return resolved === demoLibraryPath() || resolved === demoUploadsPath()
}
