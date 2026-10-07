import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type pg from 'pg'
import { from as copyFrom } from 'pg-copy-streams'
import yauzl from 'yauzl'
import { encryptSecret, getPreviewStore, isSafeRelativePath, managedRoot } from '@pb/core'
import { applyMigrations, readMigrationSteps, type MigrationStep } from '@pb/db/migrations'
import {
  BACKUP_FORMAT_VERSION,
  BackupError,
  FILES_PREFIX,
  MANIFEST_ENTRY,
  SECRETS_ENTRY,
  manifestSchema,
  secretsSchema,
  tableEntry,
  type BackupManifest,
  type BackupSecret,
} from './manifest'
import { checkVerifier, deriveKey, open } from './passphrase-box'
import { SECRET_COLUMNS, listForeignKeys, listTables, quoteIdent } from './tables'

/**
 * Replaces this instance with the contents of a backup.
 *
 * Everything that can be checked is checked before anything is changed. The
 * database is then rebuilt inside one transaction — schema dropped, recreated
 * as it was when the backup was taken, rows loaded — so a failure at any
 * point, including a crash, leaves the instance exactly as it was. Only after
 * that commits is the schema brought forward to this build's.
 *
 * Rebuilding at the backup's own schema version is what lets an older backup
 * restore into a newer PrintBench: the rows go into the tables they came from,
 * and the ordinary migrations do the rest.
 */

const MANIFEST_MAX_BYTES = 20 * 1024 * 1024
const SECRETS_MAX_BYTES = 50 * 1024 * 1024

interface FileEntry {
  entry: yauzl.Entry
  libraryId: string
  relative: string
}

export interface OpenedBackup {
  manifest: BackupManifest
  files: FileEntry[]
  has(name: string): boolean
  stream(name: string): Promise<Readable>
  close(): void
}

/** Opens an uploaded file and validates it. Changes nothing. */
export async function openBackup(
  file: string,
  steps: MigrationStep[] = readMigrationSteps(),
): Promise<OpenedBackup> {
  let zip: yauzl.ZipFile
  const entries = new Map<string, yauzl.Entry>()
  try {
    // yauzl rejects absolute paths and `..` in entry names on its own.
    zip = await yauzl.openPromise(file, { lazyEntries: true, autoClose: false })
    await new Promise<void>((resolve, reject) => {
      zip.on('entry', (entry: yauzl.Entry) => {
        if (!entry.fileName.endsWith('/')) entries.set(entry.fileName, entry)
        zip.readEntry()
      })
      zip.on('end', resolve)
      zip.on('error', reject)
      zip.readEntry()
    })
  } catch {
    throw new BackupError('That file is not a PrintBench backup, or it is damaged.')
  }

  const stream = (name: string): Promise<Readable> => {
    const entry = entries.get(name)
    if (!entry) return Promise.reject(new BackupError(`The backup is missing ${name}.`))
    return zip.openReadStreamPromise(entry)
  }

  try {
    const manifestEntry = entries.get(MANIFEST_ENTRY)
    if (!manifestEntry || manifestEntry.uncompressedSize > MANIFEST_MAX_BYTES) {
      throw new BackupError('That file is not a PrintBench backup.')
    }

    let manifest: BackupManifest
    try {
      manifest = manifestSchema.parse(JSON.parse(await readText(await stream(MANIFEST_ENTRY))))
    } catch {
      throw new BackupError('The backup describes itself in a way this version cannot read.')
    }

    if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
      throw new BackupError(
        `That backup is format version ${manifest.formatVersion}; this version of PrintBench reads version ${BACKUP_FORMAT_VERSION}.`,
      )
    }

    const newest = steps.at(-1)
    if (newest && manifest.migration.when > newest.when) {
      throw new BackupError(
        `That backup was made by a newer PrintBench (${manifest.appVersion ?? 'unknown version'}). Upgrade this instance first, then restore.`,
      )
    }
    if (steps[manifest.migration.index]?.when !== manifest.migration.when) {
      throw new BackupError('That backup comes from a database this version does not recognise.')
    }

    const seen = new Set<string>()
    for (const table of manifest.tables) {
      if (seen.has(table.name)) throw new BackupError(`The backup lists ${table.name} twice.`)
      seen.add(table.name)
      if (!entries.has(tableEntry(table.name))) {
        throw new BackupError(`The backup is missing the data for ${table.name}.`)
      }
    }

    const fileLibraries = new Set(
      manifest.libraries
        .filter((library) => library.kind === 'managed' && library.backend === 'local')
        .map((library) => library.id),
    )
    const files: FileEntry[] = []
    for (const [name, entry] of entries) {
      if (!name.startsWith(FILES_PREFIX)) continue
      const rest = name.slice(FILES_PREFIX.length)
      const slash = rest.indexOf('/')
      const libraryId = rest.slice(0, slash)
      const relative = rest.slice(slash + 1)
      if (slash < 0 || !fileLibraries.has(libraryId) || !isSafeRelativePath(relative)) {
        throw new BackupError(`The backup contains a file it should not: ${name}`)
      }
      files.push({ entry, libraryId, relative })
    }

    return {
      manifest,
      files,
      has: (name) => entries.has(name),
      stream,
      close: () => zip.close(),
    }
  } catch (error) {
    zip.close()
    throw error
  }
}

export type RestorePhase = 'checking' | 'files' | 'database' | 'upgrading'

export interface RestoreOptions {
  pool: pg.Pool
  file: string
  passphrase?: string
  /** Where managed libraries live on this instance. */
  managedRoot?: string
  onPhase?: (phase: RestorePhase) => void
}

export interface RestoreResult {
  manifest: BackupManifest
  filesRestored: number
  secretsRestored: number
}

export async function restoreBackup(options: RestoreOptions): Promise<RestoreResult> {
  const { pool } = options
  const steps = readMigrationSteps()

  options.onPhase?.('checking')
  const backup = await openBackup(options.file, steps)
  try {
    const { manifest } = backup
    const secrets = await readSecrets(backup, options.passphrase)
    const libraryPaths = planLibraryPaths(manifest, options.managedRoot ?? managedRoot())

    /*
     * Files go first, before the database changes. If the load then fails, the
     * old database is untouched and the extra files are inert — the reverse
     * order could leave a restored database pointing at files that never
     * arrived.
     */
    options.onPhase?.('files')
    for (const directory of libraryPaths.values()) await mkdir(directory, { recursive: true })
    for (const file of backup.files) {
      const root = libraryPaths.get(file.libraryId)!
      const target = path.resolve(root, file.relative)
      if (!target.startsWith(root + path.sep)) {
        throw new BackupError(`The backup contains a file it should not: ${file.relative}`)
      }
      await mkdir(path.dirname(target), { recursive: true })
      // Written under a temporary name so a scan never sees half a mesh.
      const temporary = `${target}.${process.pid}.restoring`
      try {
        await pipeline(await backup.stream(file.entry.fileName), createWriteStream(temporary))
        await rename(temporary, target)
      } catch (error) {
        await rm(temporary, { force: true })
        throw error
      }
    }

    options.onPhase?.('database')
    const client = await pool.connect()
    let secretsRestored = 0
    try {
      await client.query('BEGIN')
      // The web process is still running. Wait for its queries to finish, but
      // give up rather than hang if something is holding a table for good.
      await client.query("SET LOCAL lock_timeout = '30s'")
      await client.query('DROP SCHEMA IF EXISTS public CASCADE')
      await client.query('DROP SCHEMA IF EXISTS drizzle CASCADE')
      await client.query('CREATE SCHEMA public')
      await replayMigrations(client, steps.slice(0, manifest.migration.index + 1))

      const target = new Map((await listTables(client)).map((table) => [table.name, table]))
      for (const table of manifest.tables) {
        const columns = target.get(table.name)?.columns
        const unknown = columns && table.columns.find((column) => !columns.includes(column))
        if (!columns || unknown) {
          throw new BackupError(
            `The backup has data for ${table.name}${unknown ? `.${unknown}` : ''}, which does not exist at its schema version.`,
          )
        }
      }

      const foreignKeys = await listForeignKeys(client)
      for (const key of foreignKeys) {
        await client.query(
          `ALTER TABLE public.${quoteIdent(key.table)} DROP CONSTRAINT "${key.name.replace(/"/g, '""')}"`,
        )
      }

      for (const table of manifest.tables) {
        const sink = client.query(
          copyFrom(
            `COPY public.${quoteIdent(table.name)} (${table.columns.map(quoteIdent).join(', ')}) FROM STDIN`,
          ),
        )
        await pipeline(await backup.stream(tableEntry(table.name)), sink)
        if (sink.rowCount !== table.rows) {
          throw new BackupError(
            `The backup is damaged: ${table.name} should hold ${table.rows} rows but ${sink.rowCount} were read.`,
          )
        }
      }

      try {
        for (const key of foreignKeys) {
          await client.query(
            `ALTER TABLE public.${quoteIdent(key.table)} ADD CONSTRAINT "${key.name.replace(/"/g, '""')}" ${key.definition}`,
          )
        }
      } catch (error) {
        throw new BackupError(
          `The backup is damaged: its rows refer to others that are not in it (${(error as Error).message}).`,
        )
      }

      for (const [libraryId, directory] of libraryPaths) {
        await client.query('UPDATE public.libraries SET path = $1 WHERE id = $2::uuid', [
          directory,
          libraryId,
        ])
      }

      for (const secret of secrets) {
        const result = await client.query(
          `UPDATE public.${quoteIdent(secret.table)} SET ${quoteIdent(secret.column)} = $1
           WHERE ${quoteIdent(secret.keyColumn)}::text = $2`,
          [encryptSecret(secret.plaintext), secret.key],
        )
        secretsRestored += result.rowCount ?? 0
      }

      await resetSequences(client)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }

    options.onPhase?.('upgrading')
    try {
      await applyMigrations(pool)
    } catch (error) {
      console.error('[backup] restored, but migrating forward failed:', error)
      // Past the commit, so "nothing was changed" would be a lie.
      throw new BackupError(
        'The backup was restored, but upgrading its data to this version failed. Restart PrintBench to try the upgrade again.',
      )
    }

    return { manifest, filesRestored: backup.files.length, secretsRestored }
  } finally {
    backup.close()
  }
}

/**
 * Checks a passphrase against a backup without restoring anything, so a typo
 * is reported at once rather than after work has been paused.
 */
export async function verifyBackupPassphrase(file: string, passphrase?: string): Promise<void> {
  const backup = await openBackup(file)
  try {
    await readSecrets(backup, passphrase)
  } finally {
    backup.close()
  }
}

/** Runs migrations one by one and records them the way drizzle's migrator does. */
export async function replayMigrations(client: pg.ClientBase, steps: MigrationStep[]) {
  await client.query('CREATE SCHEMA IF NOT EXISTS drizzle')
  await client.query(`
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )`)
  for (const step of steps) {
    for (const statement of step.statements) await client.query(statement)
    await client.query(
      'INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)',
      [step.hash, step.when],
    )
  }
}

interface OpenedSecret {
  table: string
  column: string
  keyColumn: string
  key: string
  plaintext: string
}

async function readSecrets(backup: OpenedBackup, passphrase?: string): Promise<OpenedSecret[]> {
  const meta = backup.manifest.secrets
  // No passphrase is a choice, not a mistake: the restore goes ahead and the
  // credentials are simply re-entered afterwards.
  if (!meta || !passphrase) return []

  const key = deriveKey(passphrase, meta.salt)
  if (!checkVerifier(meta.verifier, key)) {
    throw new BackupError('That passphrase does not match this backup.')
  }

  if (!backup.has(SECRETS_ENTRY)) return []

  let sealed: BackupSecret[]
  try {
    sealed = secretsSchema.parse(
      JSON.parse(await readText(await backup.stream(SECRETS_ENTRY), SECRETS_MAX_BYTES)),
    )
  } catch {
    throw new BackupError('The stored credentials in that backup cannot be read.')
  }

  const opened: OpenedSecret[] = []
  for (const secret of sealed) {
    // Only ever into a column this build knows to hold a credential. The file
    // is uploaded, so it does not get to name arbitrary columns to overwrite.
    const known = SECRET_COLUMNS.find(
      (candidate) => candidate.table === secret.table && candidate.column === secret.column,
    )
    const plaintext = open(secret.value, key)
    if (!known || plaintext === null) {
      throw new BackupError('The stored credentials in that backup cannot be read.')
    }
    opened.push({
      table: known.table,
      column: known.column,
      keyColumn: known.key,
      key: secret.key,
      plaintext,
    })
  }
  return opened
}

/**
 * Where each managed library's folder will be on this instance.
 *
 * Between two Docker installs the path is the same. Anywhere else — a
 * different DATA_DIR, a development checkout — the source path means nothing
 * here, so the folder keeps its name and moves under this instance's root.
 */
function planLibraryPaths(manifest: BackupManifest, root: string): Map<string, string> {
  const resolvedRoot = path.resolve(root)
  const planned = new Map<string, string>()
  const taken = new Set<string>()

  for (const library of manifest.libraries) {
    if (library.kind !== 'managed' || library.backend !== 'local' || !library.path) continue

    const source = path.resolve(library.path)
    let target = source.startsWith(resolvedRoot + path.sep)
      ? source
      : path.join(resolvedRoot, path.basename(source) || library.id)
    if (taken.has(target)) target = path.join(resolvedRoot, library.id)

    taken.add(target)
    planned.set(library.id, target)
  }
  return planned
}

/** COPY writes explicit ids, which leaves every sequence behind its table. */
async function resetSequences(client: pg.ClientBase): Promise<void> {
  const owned = await client.query<{ table: string; column: string; sequence: string }>(`
    SELECT c.relname::text AS "table", a.attname::text AS "column",
           pg_get_serial_sequence(format('public.%I', c.relname), a.attname) AS sequence
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
      AND pg_get_serial_sequence(format('public.%I', c.relname), a.attname) IS NOT NULL`)

  for (const { table, column, sequence } of owned.rows) {
    await client.query(
      `SELECT setval($1::regclass, COALESCE(max(${quoteIdent(column)}), 1), max(${quoteIdent(column)}) IS NOT NULL)
       FROM public.${quoteIdent(table)}`,
      [sequence],
    )
  }
}

/**
 * Finds files whose thumbnail is recorded as rendered but is not on this disk,
 * and marks them to be rendered again.
 *
 * Thumbnails are left out of a backup, so on a different machine that is every
 * one of them; restoring onto the instance the backup came from, it is usually
 * none. Returns the file ids to enqueue.
 */
export async function markMissingPreviews(pool: pg.Pool): Promise<string[]> {
  const store = getPreviewStore()
  const rows = await pool.query<{ id: string; thumb_key: string }>(
    `SELECT id::text, thumb_key FROM model_files
     WHERE thumb_state = 'ok' AND thumb_key IS NOT NULL AND missing_at IS NULL`,
  )

  const missing: string[] = []
  for (const row of rows.rows) {
    const present = await store.has(row.thumb_key).catch(() => false)
    if (!present) missing.push(row.id)
  }

  const CHUNK = 5000
  for (let i = 0; i < missing.length; i += CHUNK) {
    await pool.query(
      `UPDATE model_files SET thumb_state = 'pending', thumb_key = NULL, thumb_error = NULL
       WHERE id = ANY($1::uuid[])`,
      [missing.slice(i, i + CHUNK)],
    )
  }
  return missing
}

async function readText(stream: Readable, limit = MANIFEST_MAX_BYTES): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > limit) throw new BackupError('The backup is larger than expected.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}
