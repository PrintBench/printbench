import { z } from 'zod'

/**
 * What a backup says about itself.
 *
 * The manifest is read before anything else and decides whether a restore may
 * proceed at all. It comes from an uploaded file, so it is parsed strictly:
 * table and column names end up in SQL as identifiers, and nothing reaches
 * that point without matching IDENTIFIER first.
 */

export const BACKUP_FORMAT_VERSION = 1
export const BACKUP_EXTENSION = 'pbbackup'

export const MANIFEST_ENTRY = 'manifest.json'
export const SECRETS_ENTRY = 'secrets.json'
export const tableEntry = (table: string) => `db/${table}.copy`
export const FILES_PREFIX = 'files/'

/** Lower-case SQL identifiers only, which is all this schema has ever used. */
export const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/

const identifier = z.string().regex(IDENTIFIER)

export const manifestSchema = z.object({
  formatVersion: z.number().int(),
  appVersion: z.string().max(40).nullable(),
  createdAt: z.string().max(40),
  /** The newest migration applied to the source database, by journal timestamp. */
  migration: z.object({ when: z.number().int(), index: z.number().int() }),
  tables: z
    .array(
      z.object({
        name: identifier,
        columns: z.array(identifier).min(1).max(400),
        rows: z.number().int().nonnegative(),
      }),
    )
    .max(500),
  libraries: z
    .array(
      z.object({
        id: z.string().uuid(),
        name: z.string().max(300),
        kind: z.enum(['in_place', 'managed']),
        backend: z.enum(['local', 's3']),
        path: z.string().max(4000).nullable(),
      }),
    )
    .max(10_000),
  files: z.object({
    included: z.boolean(),
    count: z.number().int().nonnegative(),
    bytes: z.number().nonnegative(),
  }),
  /** Present only when a passphrase was given; otherwise credentials were left out. */
  secrets: z
    .object({
      count: z.number().int().nonnegative(),
      salt: z.string().max(200),
      verifier: z.string().max(400),
    })
    .nullable(),
})

export type BackupManifest = z.infer<typeof manifestSchema>

export const secretsSchema = z
  .array(
    z.object({
      table: identifier,
      column: identifier,
      key: z.string().max(200),
      value: z.string().max(200_000),
    }),
  )
  .max(100_000)

export type BackupSecret = z.infer<typeof secretsSchema>[number]

/** What the UI shows before asking someone to confirm a restore. */
export interface BackupSummary {
  appVersion: string | null
  createdAt: string
  rows: number
  counts: { users: number; models: number; libraries: number }
  files: BackupManifest['files']
  /** Managed libraries whose uploads are in a backup, or would need copying across. */
  managedLibraries: number
  hasSecrets: boolean
  secretCount: number
}

export function summarize(manifest: BackupManifest): BackupSummary {
  const rowsOf = (name: string) => manifest.tables.find((table) => table.name === name)?.rows ?? 0
  return {
    appVersion: manifest.appVersion,
    createdAt: manifest.createdAt,
    rows: manifest.tables.reduce((total, table) => total + table.rows, 0),
    counts: { users: rowsOf('user'), models: rowsOf('models'), libraries: rowsOf('libraries') },
    files: manifest.files,
    managedLibraries: manifest.libraries.filter(
      (library) => library.kind === 'managed' && library.backend === 'local',
    ).length,
    hasSecrets: manifest.secrets !== null,
    secretCount: manifest.secrets?.count ?? 0,
  }
}

/** A problem with the backup itself, safe to show to whoever uploaded it. */
export class BackupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackupError'
  }
}
