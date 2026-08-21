import { sql } from 'drizzle-orm'
import type { Database } from '@pb/db'

/**
 * Site-wide settings.
 *
 * Deliberately small. Every setting is a decision someone has to understand,
 * and a settings page with forty switches is how a self-hosted app becomes
 * unconfigurable — the reference application's is a good warning. Anything
 * belonging to one library lives on the library, not here.
 *
 * Stored as jsonb keyed by name, and always read through this module so the
 * defaults live in exactly one place. A missing row means "the default", which
 * is what makes a fresh install work with an empty table.
 */

export interface Settings {
  /** Shown in the header and the browser title. */
  siteName: string
  /**
   * Whether a signed-out visitor can view models shared by link.
   * Off by default: sharing should be a decision, not a discovery.
   */
  publicSharing: boolean
  /** Roles below this cannot see the library at all. Reserved for later SSO work. */
  defaultRole: 'viewer' | 'member'
  /** Days a missing model is kept before it can be hard-deleted. */
  missingGraceDays: number
  /** Refuse to load a mesh larger than this in the browser viewer. */
  viewerMaxBytes: number
  /** Raise metadata-completeness problems (no licence, no tags, and so on). */
  trackMetadataProblems: boolean
  /** Write .printbench.json into managed libraries as metadata changes. */
  writeSidecars: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  siteName: 'PrintBench',
  publicSharing: false,
  defaultRole: 'viewer',
  missingGraceDays: 30,
  viewerMaxBytes: 150 * 1024 * 1024,
  trackMetadataProblems: true,
  writeSidecars: true,
}

export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SettingsValidationError'
  }
}

/**
 * Range-checks and coerces one setting.
 *
 * Values arrive from a form and go into jsonb, which will accept anything at
 * all — so this is the only thing standing between a typo and a grace period
 * of zero days quietly deleting a NAS full of metadata.
 */
export function validate<K extends keyof Settings>(key: K, value: unknown): Settings[K] {
  switch (key) {
    case 'siteName': {
      const name = String(value ?? '').trim()
      if (!name) throw new SettingsValidationError('The site needs a name.')
      if (name.length > 60) throw new SettingsValidationError('Keep the name under 60 characters.')
      return name as Settings[K]
    }

    case 'publicSharing':
    case 'trackMetadataProblems':
    case 'writeSidecars':
      return Boolean(value) as Settings[K]

    case 'defaultRole': {
      if (value !== 'viewer' && value !== 'member') {
        // Never admin: a default that grants administration is a mistake
        // nobody notices until it matters.
        throw new SettingsValidationError('New accounts can default to viewer or member only.')
      }
      return value as Settings[K]
    }

    case 'missingGraceDays': {
      const days = Number(value)
      if (!Number.isFinite(days) || days < 1 || days > 365) {
        throw new SettingsValidationError('The grace period must be between 1 and 365 days.')
      }
      return Math.round(days) as Settings[K]
    }

    case 'viewerMaxBytes': {
      const bytes = Number(value)
      if (!Number.isFinite(bytes) || bytes < 1024 * 1024) {
        throw new SettingsValidationError('The viewer limit must be at least 1 MB.')
      }
      if (bytes > 4 * 1024 * 1024 * 1024) {
        throw new SettingsValidationError('The viewer limit must be under 4 GB.')
      }
      return Math.round(bytes) as Settings[K]
    }

    default:
      throw new SettingsValidationError(`Unknown setting: ${String(key)}`)
  }
}

/**
 * Every setting, with defaults filled in.
 *
 * A stored value that no longer validates is discarded in favour of the
 * default rather than thrown: a bad row written by an older version must not
 * make the whole instance unbootable.
 */
export async function getSettings(db: Database): Promise<Settings> {
  const rows = await db.execute<{ key: string; value: unknown }>(
    sql`SELECT key, value FROM settings`,
  )

  const settings = { ...DEFAULT_SETTINGS }
  for (const row of rows.rows) {
    if (!(row.key in DEFAULT_SETTINGS)) continue
    const key = row.key as keyof Settings
    try {
      // jsonb round-trips scalars, so a stored string arrives as a string.
      ;(settings as Record<string, unknown>)[key] = validate(key, row.value)
    } catch {
      // Keep the default and carry on.
    }
  }
  return settings
}

export async function getSetting<K extends keyof Settings>(
  db: Database,
  key: K,
): Promise<Settings[K]> {
  return (await getSettings(db))[key]
}

/** Writes a partial update, validating each value first. */
export async function updateSettings(
  db: Database,
  patch: Partial<Settings>,
): Promise<Settings> {
  const entries = Object.entries(patch).filter(([key]) => key in DEFAULT_SETTINGS)

  // Validate everything before writing anything, so a form with one bad field
  // does not half-apply.
  const validated = entries.map(
    ([key, value]) => [key, validate(key as keyof Settings, value)] as const,
  )

  for (const [key, value] of validated) {
    await db.execute(sql`
      INSERT INTO settings (key, value, updated_at)
      VALUES (${key}, ${JSON.stringify(value)}::jsonb, now())
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`)
  }

  return getSettings(db)
}

/** Drops a setting so it falls back to its default. */
export async function resetSetting(db: Database, key: keyof Settings): Promise<void> {
  await db.execute(sql`DELETE FROM settings WHERE key = ${key}`)
}
