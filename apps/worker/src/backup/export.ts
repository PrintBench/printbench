import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { Transform, type Readable, type Writable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { ZipArchive, type ArchiverError, type ZipEntryData } from 'archiver'
import type pg from 'pg'
import { to as copyTo } from 'pg-copy-streams'
import { decryptSecret } from '@pb/core'
import {
  BACKUP_FORMAT_VERSION,
  FILES_PREFIX,
  MANIFEST_ENTRY,
  SECRETS_ENTRY,
  tableEntry,
  type BackupManifest,
  type BackupSecret,
} from './manifest'
import { deriveKey, makeVerifier, newSalt, seal } from './passphrase-box'
import {
  EXCLUDED_TABLES,
  SECRET_COLUMNS,
  currentMigration,
  listTables,
  quoteIdent,
  type TableInfo,
} from './tables'

/**
 * Writes a backup of the whole instance as one ZIP.
 *
 * The database is read inside a single repeatable-read transaction, so every
 * table is seen as of the same instant however long the copy takes and
 * whatever the app does meanwhile. Rows are streamed straight from COPY into
 * the archive; nothing is held in memory but the manifest.
 *
 * Uploaded files are optional, because they can be tens of gigabytes. Only
 * managed libraries on local disk are included: an in-place library is the
 * owner's own folder and an S3 library lives somewhere else already.
 */

export interface ExportOptions {
  pool: pg.Pool
  output: Writable
  includeFiles: boolean
  /** Without one, stored credentials are left out of the backup. */
  passphrase?: string
  appVersion?: string
  /** Aborts the archive when the client goes away. */
  signal?: AbortSignal
}

export async function writeBackup(options: ExportOptions): Promise<BackupManifest> {
  const { pool, output } = options

  // Compress the table data; files are stored as-is, since meshes barely
  // shrink and deflating gigabytes of them would only cost time.
  const archive = new ZipArchive({ zlib: { level: 6 } })
  const failed = new Promise<never>((_, reject) => {
    archive.on('error', (error: ArchiverError) => reject(error))
    output.on('error', reject)
  })
  // The awaits below race against this; without a handler of its own, a
  // failure between two of them would be an unhandled rejection.
  failed.catch(() => undefined)
  archive.on('warning', (error: ArchiverError) => {
    console.warn(`[backup] ${error.message}`)
  })
  options.signal?.addEventListener('abort', () => archive.abort(), { once: true })
  archive.pipe(output)

  const append = (source: Readable | string, name: string) =>
    Promise.race([appendEntry(archive, source, name), failed])

  const client = await pool.connect()
  let tables: BackupManifest['tables']
  let migration: BackupManifest['migration']
  let libraries: BackupManifest['libraries']
  let secrets: BackupManifest['secrets'] = null

  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')

    migration = await currentMigration(client)
    const included = (await listTables(client)).filter((table) => !EXCLUDED_TABLES.has(table.name))

    tables = []
    for (const table of included) {
      const counter = new RowCounter()
      const rows = client.query(copyTo(copyStatement(table)))
      rows.on('error', (error) => counter.destroy(error))
      await append(rows.pipe(counter), tableEntry(table.name))
      tables.push({ name: table.name, columns: table.columns, rows: counter.rows })
    }

    libraries = (
      await client.query<BackupManifest['libraries'][number]>(
        'SELECT id::text, name, kind::text, backend::text, path FROM libraries ORDER BY name',
      )
    ).rows

    if (options.passphrase) {
      const salt = newSalt()
      const key = deriveKey(options.passphrase, salt)
      const sealed = await readSecrets(client, included, key)
      await append(JSON.stringify(sealed), SECRETS_ENTRY)
      secrets = { count: sealed.length, salt, verifier: makeVerifier(key) }
    }

    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    archive.abort()
    throw error
  } finally {
    client.release()
  }

  const files = { included: options.includeFiles, count: 0, bytes: 0 }
  if (options.includeFiles) {
    for (const library of libraries) {
      if (library.kind !== 'managed' || library.backend !== 'local' || !library.path) continue
      for await (const file of walk(library.path)) {
        if (options.signal?.aborted) throw new Error('Backup cancelled')
        // file() opens each one only when its turn comes; the typings just
        // do not admit that it takes the same per-entry options as append().
        const entry: ZipEntryData = {
          name: `${FILES_PREFIX}${library.id}/${file.relative}`,
          store: true,
        }
        archive.file(file.absolute, entry)
        files.count++
        files.bytes += file.size
      }
    }
  }

  const manifest: BackupManifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: options.appVersion ?? null,
    createdAt: new Date().toISOString(),
    migration,
    tables,
    libraries,
    files,
    secrets,
  }
  // Last, because the row counts are only known once the tables are written.
  // A ZIP is read from its directory at the end, so the position costs nothing.
  archive.append(JSON.stringify(manifest, null, 2), { name: MANIFEST_ENTRY })

  await Promise.race([archive.finalize(), failed])
  await Promise.race([finished(output), failed])
  return manifest
}

function copyStatement(table: TableInfo): string {
  const secret = new Set<string>(
    SECRET_COLUMNS.filter((entry) => entry.table === table.name).map((entry) => entry.column),
  )
  const columns = table.columns.map((column) =>
    secret.has(column) ? `NULL::text AS ${quoteIdent(column)}` : quoteIdent(column),
  )
  return `COPY (SELECT ${columns.join(', ')} FROM public.${quoteIdent(table.name)}) TO STDOUT`
}

/** Stored credentials, decrypted with this instance's secret and sealed under the passphrase. */
async function readSecrets(
  client: pg.ClientBase,
  tables: TableInfo[],
  key: Buffer,
): Promise<BackupSecret[]> {
  const sealed: BackupSecret[] = []
  for (const entry of SECRET_COLUMNS) {
    const table = tables.find((candidate) => candidate.name === entry.table)
    // Absent on a database older than the migration that added it.
    if (!table?.columns.includes(entry.column)) continue

    const rows = await client.query<{ key: string; value: string }>(
      `SELECT ${quoteIdent(entry.key)}::text AS key, ${quoteIdent(entry.column)} AS value
       FROM public.${quoteIdent(entry.table)} WHERE ${quoteIdent(entry.column)} IS NOT NULL`,
    )
    for (const row of rows.rows) {
      // Null when BETTER_AUTH_SECRET was rotated after it was saved. It was
      // already unusable here, so there is nothing to carry across.
      const plaintext = decryptSecret(row.value)
      if (plaintext === null) continue
      sealed.push({
        table: entry.table,
        column: entry.column,
        key: row.key,
        value: seal(plaintext, key),
      })
    }
  }
  return sealed
}

/** Resolves once the archive has finished writing this entry. */
function appendEntry(archive: ZipArchive, source: Readable | string, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: { name: string }) => {
      if (entry.name !== name) return
      archive.off('entry', onEntry)
      resolve()
    }
    archive.on('entry', onEntry)
    if (typeof source !== 'string') source.on('error', reject)
    archive.append(source, { name })
  })
}

/**
 * Counts rows as they pass. COPY's text format ends every row with a newline
 * and escapes any newline inside a value, so counting the byte is exact.
 */
class RowCounter extends Transform {
  rows = 0

  override _transform(chunk: Buffer, _encoding: string, done: (error?: Error | null) => void) {
    for (const byte of chunk) if (byte === 0x0a) this.rows++
    this.push(chunk)
    done()
  }
}

/** Every regular file under a directory. Symlinks are skipped, not followed. */
async function* walk(
  root: string,
  relative = '',
): AsyncGenerator<{ absolute: string; relative: string; size: number }> {
  let entries
  try {
    entries = await readdir(path.join(root, relative), { withFileTypes: true })
  } catch (error) {
    // A library whose folder is gone is backed up as its rows alone.
    console.warn(
      `[backup] skipping unreadable folder ${path.join(root, relative)}: ${String(error)}`,
    )
    return
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      yield* walk(root, child)
    } else if (entry.isFile()) {
      const absolute = path.join(root, child)
      const info = await stat(absolute).catch(() => null)
      if (info) yield { absolute, relative: child, size: info.size }
    }
  }
}
