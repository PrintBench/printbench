import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDb } from '@pb/db'
import {
  DEFAULT_SETTINGS,
  SettingsValidationError,
  getSetting,
  getSettings,
  resetSetting,
  updateSettings,
  validate,
} from './settings-service'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

describe('validation', () => {
  it('accepts sensible values', () => {
    expect(validate('siteName', '  Rich’s Prints  ')).toBe('Rich’s Prints')
    expect(validate('missingGraceDays', '45')).toBe(45)
    expect(validate('publicSharing', true)).toBe(true)
    expect(validate('viewerMaxBytes', 200 * 1024 * 1024)).toBe(200 * 1024 * 1024)
  })

  it('refuses an empty site name', () => {
    expect(() => validate('siteName', '   ')).toThrow(SettingsValidationError)
  })

  /*
   * The grace period is what stops an unmounted NAS turning into permanent
   * data loss. Zero days would mean a missing model is deletable immediately.
   */
  it('refuses a grace period that would delete metadata at once', () => {
    expect(() => validate('missingGraceDays', 0)).toThrow(SettingsValidationError)
    expect(() => validate('missingGraceDays', -1)).toThrow(SettingsValidationError)
    expect(() => validate('missingGraceDays', 'soon')).toThrow(SettingsValidationError)
  })

  it('refuses an absurd grace period', () => {
    expect(() => validate('missingGraceDays', 100_000)).toThrow(SettingsValidationError)
  })

  // A default role of admin is a mistake nobody notices until it matters.
  it('refuses to make new accounts admins by default', () => {
    expect(() => validate('defaultRole', 'admin')).toThrow(SettingsValidationError)
    expect(validate('defaultRole', 'member')).toBe('member')
  })

  it('refuses a viewer limit that would break every model', () => {
    expect(() => validate('viewerMaxBytes', 1000)).toThrow(SettingsValidationError)
    expect(() => validate('viewerMaxBytes', 8 * 1024 * 1024 * 1024)).toThrow(
      SettingsValidationError,
    )
  })

  it('refuses an unknown key', () => {
    expect(() => validate('nonsense' as never, 'x')).toThrow(SettingsValidationError)
  })

  it('coerces truthiness for the switches', () => {
    expect(validate('publicSharing', 'on')).toBe(true)
    expect(validate('publicSharing', undefined)).toBe(false)
  })
})

describeDb('settings storage', () => {
  let pool: ReturnType<typeof createDb>['pool']
  let db: ReturnType<typeof createDb>['db']

  beforeAll(() => {
    ;({ pool, db } = createDb())
  })

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM settings`)
  })

  afterAll(async () => {
    await db.execute(sql`DELETE FROM settings`)
    await pool.end()
  })

  // What makes a fresh install work with an empty table.
  it('returns defaults when nothing is stored', async () => {
    expect(await getSettings(db)).toEqual(DEFAULT_SETTINGS)
  })

  it('round-trips an update', async () => {
    await updateSettings(db, { siteName: 'Workshop', missingGraceDays: 14 })
    const settings = await getSettings(db)

    expect(settings.siteName).toBe('Workshop')
    expect(settings.missingGraceDays).toBe(14)
    // Untouched settings keep their defaults.
    expect(settings.publicSharing).toBe(DEFAULT_SETTINGS.publicSharing)
  })

  it('reads one setting', async () => {
    await updateSettings(db, { publicSharing: true })
    expect(await getSetting(db, 'publicSharing')).toBe(true)
  })

  it('preserves booleans set to false', async () => {
    // A naive implementation using `||` for the default turns a stored false
    // back into the default true.
    await updateSettings(db, { writeSidecars: false })
    expect(await getSetting(db, 'writeSidecars')).toBe(false)
  })

  it('validates before writing anything', async () => {
    await updateSettings(db, { siteName: 'Good Name' })

    await expect(
      updateSettings(db, { siteName: 'Better Name', missingGraceDays: -5 }),
    ).rejects.toThrow(SettingsValidationError)

    // The valid half of the rejected update must not have landed.
    expect(await getSetting(db, 'siteName')).toBe('Good Name')
  })

  it('ignores keys that are not settings', async () => {
    await updateSettings(db, { nonsense: true } as never)
    const rows = await db.execute<{ count: number }>(sql`SELECT count(*)::int FROM settings`)
    expect(rows.rows[0]!.count).toBe(0)
  })

  /*
   * A row written by an older version, or edited by hand, must not make the
   * instance unbootable — every page load reads these.
   */
  it('falls back to the default for a stored value that no longer validates', async () => {
    await db.execute(sql`
      INSERT INTO settings (key, value) VALUES ('missingGraceDays', '-99'::jsonb)`)
    expect(await getSetting(db, 'missingGraceDays')).toBe(DEFAULT_SETTINGS.missingGraceDays)
  })

  it('ignores a stored key that is no longer a setting', async () => {
    await db.execute(sql`INSERT INTO settings (key, value) VALUES ('retired', '"x"'::jsonb)`)
    await expect(getSettings(db)).resolves.toBeTruthy()
  })

  it('resets to the default', async () => {
    await updateSettings(db, { siteName: 'Temporary' })
    await resetSetting(db, 'siteName')
    expect(await getSetting(db, 'siteName')).toBe(DEFAULT_SETTINGS.siteName)
  })
})
