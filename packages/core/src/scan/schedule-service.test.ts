import { describe, expect, it } from 'vitest'
import {
  SCHEDULE_PRESETS,
  cronProblem,
  describeCron,
  isScanDue,
  isValidCron,
  nextRun,
} from './schedule-service'

/**
 * Scan scheduling.
 *
 * The decision is entirely a function of (cron, last scan, now), so it is
 * tested as one — no database, no clock. What matters is that a schedule
 * survives a restart, which it does precisely because nothing is remembered
 * between sweeps.
 */

const at = (iso: string) => new Date(iso)

describe('isValidCron', () => {
  it('accepts every preset', () => {
    for (const preset of SCHEDULE_PRESETS) {
      expect(isValidCron(preset.cron), preset.label).toBe(true)
    }
  })

  it('accepts an expression someone typed themselves', () => {
    expect(isValidCron('30 2 * * 1-5')).toBe(true)
  })

  // Empty means "no schedule", which is a valid choice rather than an error.
  it('treats empty as valid', () => {
    expect(isValidCron('')).toBe(true)
    expect(isValidCron(null)).toBe(true)
    expect(isValidCron(undefined)).toBe(true)
  })

  it('rejects nonsense', () => {
    expect(isValidCron('every tuesday')).toBe(false)
    expect(isValidCron('99 * * * *')).toBe(false)
  })

  /*
   * A scan walks the whole library. cron-parser happily accepts "* * * * *",
   * and a two-field "* *" as well, both meaning every minute — which would
   * keep a NAS awake permanently for no benefit, since the fast scan already
   * skips unchanged directories.
   */
  it('rejects a schedule that would scan constantly', () => {
    expect(isValidCron('* * * * *')).toBe(false)
    expect(isValidCron('* *')).toBe(false)
    expect(isValidCron('*/5 * * * *')).toBe(false)

    expect(cronProblem('* * * * *')).toMatch(/15 minutes/)
  })

  it('accepts the shortest sensible interval', () => {
    expect(isValidCron('*/15 * * * *')).toBe(true)
  })

  it('explains what is wrong rather than just refusing', () => {
    expect(cronProblem('every tuesday')).toMatch(/presets/i)
    expect(cronProblem('0 3 * * *')).toBeNull()
    expect(cronProblem('')).toBeNull()
  })
})

describe('isScanDue', () => {
  it('is never due without a schedule', () => {
    expect(isScanDue('', at('2026-08-20T12:00:00Z'), at('2026-08-20T12:00:00Z'))).toBe(false)
    expect(isScanDue(null, null)).toBe(false)
  })

  /*
   * What makes "add a library and walk away" work: a library with a schedule
   * and no scan yet is due immediately rather than at the next fire time.
   */
  it('is due at once when it has never been scanned', () => {
    expect(isScanDue('0 3 * * *', null, at('2026-08-20T12:00:00Z'))).toBe(true)
  })

  it('is due when a fire time has passed since the last scan', () => {
    // Daily at 03:00. Last scanned yesterday morning, now it is this afternoon.
    expect(isScanDue('0 3 * * *', at('2026-08-19T03:05:00Z'), at('2026-08-20T12:00:00Z'))).toBe(
      true,
    )
  })

  it('is not due when the last scan is after the most recent fire time', () => {
    expect(isScanDue('0 3 * * *', at('2026-08-20T03:05:00Z'), at('2026-08-20T12:00:00Z'))).toBe(
      false,
    )
  })

  it('is not due again within the same hour for an hourly schedule', () => {
    expect(isScanDue('0 * * * *', at('2026-08-20T12:00:30Z'), at('2026-08-20T12:30:00Z'))).toBe(
      false,
    )
  })

  it('is due once the next hour turns over', () => {
    expect(isScanDue('0 * * * *', at('2026-08-20T12:00:30Z'), at('2026-08-20T13:00:10Z'))).toBe(
      true,
    )
  })

  /*
   * The restart case. Nothing is remembered between sweeps, so a scan missed
   * while the worker was down is picked up as soon as it comes back rather
   * than being skipped until the following fire.
   */
  it('catches up after downtime', () => {
    expect(isScanDue('0 3 * * *', at('2026-08-10T03:00:00Z'), at('2026-08-20T12:00:00Z'))).toBe(
      true,
    )
  })

  it('does not throw on an unparseable schedule', () => {
    // One bad library must not take down the sweep for every other library.
    expect(isScanDue('not a cron', null, at('2026-08-20T12:00:00Z'))).toBe(false)
  })

  it('never fires for a schedule that was rejected as too frequent', () => {
    expect(isScanDue('* * * * *', null, at('2026-08-20T12:00:00Z'))).toBe(false)
  })
})

describe('describeCron', () => {
  it('names a preset', () => {
    expect(describeCron('0 3 * * *')).toBe('Daily')
    expect(describeCron('0 * * * *')).toBe('Hourly')
  })

  it('says so when there is no schedule', () => {
    expect(describeCron('')).toBe('Manual only')
    expect(describeCron(null)).toBe('Manual only')
  })

  it('falls back to the expression for a custom one', () => {
    expect(describeCron('30 2 * * 1-5')).toBe('30 2 * * 1-5')
  })
})

describe('nextRun', () => {
  /*
   * Schedules are read in the server's local timezone, not UTC — "scan at
   * 03:00" should mean three in the morning where the machine is. Asserted
   * against local hours so the test says the same thing wherever it runs.
   */
  it('reports the next fire time, in local time', () => {
    const next = nextRun('0 3 * * *', at('2026-08-20T12:00:00Z'))

    expect(next).toBeTruthy()
    expect(next!.getHours()).toBe(3)
    expect(next!.getMinutes()).toBe(0)
    // Tomorrow, since 03:00 today has already passed.
    expect(next!.getTime()).toBeGreaterThan(at('2026-08-20T12:00:00Z').getTime())
  })

  it('is null without a schedule', () => {
    expect(nextRun('')).toBeNull()
    expect(nextRun('nonsense')).toBeNull()
  })
})
