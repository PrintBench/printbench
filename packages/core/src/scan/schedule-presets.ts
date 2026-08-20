import { CronExpressionParser } from 'cron-parser'

/**
 * Per-library scan schedules.
 *
 * pg-boss keeps one schedule per queue name, so "every library on its own cron"
 * cannot be expressed with its scheduler directly. Instead a sweep runs every
 * few minutes and asks each library whether it is due — which also means a
 * schedule changed in the UI takes effect immediately, with no re-registration.
 *
 * Due-ness is decided by comparing the most recent cron fire time against when
 * the library was last scanned. Deciding it any other way — a timer, a
 * next-run column — loses schedules across a restart, which for a self-hosted
 * app that is restarted by every update is most of them.
 *
 * **Schedules are in the server's local timezone**, not UTC. "Scan at 03:00"
 * should mean three in the morning where the machine is, which for a box in
 * someone's house is the only reading that makes sense. Set TZ in the compose
 * file to control it.
 */

/**
 * The shortest interval a schedule may fire at.
 *
 * A scan walks every directory in the library. Running one every minute — which
 * a plain `* * * * *` asks for, and which cron-parser will happily accept —
 * would keep a NAS awake permanently and gain nothing, since the fast scan
 * already skips unchanged directories. Fifteen minutes is far more often than
 * anyone needs and still leaves the disk alone.
 */
export const MIN_INTERVAL_MS = 15 * 60 * 1000

/** What the UI offers. Cron underneath, so an expert can type their own. */
export const SCHEDULE_PRESETS = [
  { cron: '', label: 'Manual only', hint: 'Scan when you press the button.' },
  { cron: '0 * * * *', label: 'Hourly', hint: 'On the hour.' },
  { cron: '0 */6 * * *', label: 'Every 6 hours', hint: 'Four times a day.' },
  { cron: '0 3 * * *', label: 'Daily', hint: 'Overnight, at 03:00.' },
  { cron: '0 3 * * 0', label: 'Weekly', hint: 'Sunday at 03:00.' },
] as const

export class InvalidCronError extends Error {
  constructor(cron: string) {
    super(`"${cron}" is not a valid schedule.`)
    this.name = 'InvalidCronError'
  }
}

/** True for a cron this codebase can act on. Empty means "no schedule". */
export function isValidCron(cron: string | null | undefined): boolean {
  return cronProblem(cron) === null
}

/**
 * Why a schedule is unacceptable, or null if it is fine.
 *
 * Separate from isValidCron so the UI can say what is wrong rather than just
 * refusing.
 */
export function cronProblem(cron: string | null | undefined): string | null {
  if (!cron || cron.trim() === '') return null

  let interval: ReturnType<typeof CronExpressionParser.parse>
  try {
    interval = CronExpressionParser.parse(cron.trim())
  } catch {
    return 'That is not a schedule this understands. Try one of the presets.'
  }

  // Two consecutive fires tell us the cadence. cron-parser accepts a
  // two-field expression like "* *", which means every minute.
  const first = interval.next().toDate().getTime()
  const second = interval.next().toDate().getTime()
  if (second - first < MIN_INTERVAL_MS) {
    return 'That would scan more often than every 15 minutes, which keeps the disk awake for nothing.'
  }

  return null
}

export function describeCron(cron: string | null | undefined): string {
  if (!cron || cron.trim() === '') return 'Manual only'
  const preset = SCHEDULE_PRESETS.find((option) => option.cron === cron.trim())
  if (preset) return preset.label
  return cron.trim()
}

/**
 * Whether a scan should start now.
 *
 * The rule is "a fire time has passed that we have not scanned since". A
 * library never scanned is due as soon as it has any schedule at all, which is
 * what makes adding a library and walking away work.
 */
export function isScanDue(
  cron: string | null | undefined,
  lastScanAt: Date | null,
  now: Date = new Date(),
): boolean {
  if (!cron || cron.trim() === '') return false

  if (cronProblem(cron) !== null) return false

  let previousFire: Date
  try {
    const interval = CronExpressionParser.parse(cron.trim(), { currentDate: now })
    previousFire = interval.prev().toDate()
  } catch {
    // An unparseable schedule must not stop the library being scanned by hand,
    // and must not throw inside a sweep that covers every other library.
    return false
  }

  if (!lastScanAt) return true
  return lastScanAt.getTime() < previousFire.getTime()
}

/** The next time a schedule will fire, for showing beside it in the UI. */
export function nextRun(cron: string | null | undefined, now: Date = new Date()): Date | null {
  if (!cron || cron.trim() === '') return null
  try {
    return CronExpressionParser.parse(cron.trim(), { currentDate: now }).next().toDate()
  } catch {
    return null
  }
}
