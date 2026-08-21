import { getDb } from '@pb/db'
import { librariesDue } from '@pb/core'
import { JOB, getQueue } from '@pb/jobs'

/**
 * Starts scans whose schedule has come round.
 *
 * pg-boss keeps one schedule per queue name, so per-library crons cannot be
 * registered with it directly. This sweep runs every few minutes and asks each
 * library whether it is due, which has two happy consequences: a schedule
 * changed in the UI takes effect at the next sweep with no re-registration,
 * and a scan missed while the worker was down is picked up when it returns
 * rather than skipped until the following fire.
 */
export async function handleScheduleSweep(): Promise<void> {
  const due = await librariesDue(getDb())
  if (due.length === 0) return

  const queue = getQueue()

  for (const library of due) {
    /*
     * A fast scan: it is the scheduled, routine one. Deep scans re-stat and
     * re-digest every file, which is a weekly job at most and is left to be
     * asked for explicitly.
     *
     * library.scan is `stately`, so if a scan is already running for this
     * library exactly one more queues behind it and the rest collapse — which
     * is what keeps a slow library from building a backlog of sweeps.
     */
    await queue.send(JOB.libraryScan, { libraryId: library.id, mode: 'fast', force: false })

    console.log(
      `[schedule] queued a scan of "${library.name}" ` +
        `(last scanned ${library.lastScanAt?.toISOString() ?? 'never'})`,
    )
  }
}
