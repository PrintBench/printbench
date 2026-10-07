import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { finished } from 'node:stream/promises'
import { ZipArchive } from 'archiver'
import pg from 'pg'
import { decryptSecret, encryptSecret } from '@pb/core'
import { applyMigrations, readMigrationSteps } from '@pb/db/migrations'
import { writeBackup } from './export'
import { BackupError, MANIFEST_ENTRY, tableEntry, type BackupManifest } from './manifest'
import { openBackup, replayMigrations, restoreBackup } from './restore'
import { EXCLUDED_TABLES, SECRET_COLUMNS, listForeignKeys } from './tables'

/**
 * Backup and restore, end to end.
 *
 * Every test works in scratch databases it creates and drops itself. A restore
 * drops the whole schema, and the database the rest of the suite shares is not
 * a place to try that.
 */
const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

const LIBRARY = '5b000000-0000-4000-8000-000000000001'
const MODEL = '5b000000-0000-4000-8000-000000000002'
const FILE = '5b000000-0000-4000-8000-000000000003'
const TAG = '5b000000-0000-4000-8000-000000000004'
const PRINTER = '5b000000-0000-4000-8000-000000000005'

describeDb('backup and restore', () => {
  let admin: pg.Pool
  let work = ''
  const databases: string[] = []
  const pools: pg.Pool[] = []
  const originalSecret = process.env.BETTER_AUTH_SECRET

  /** A new, empty database and a pool on it. */
  async function scratch(): Promise<pg.Pool> {
    const name = `pb_backup_test_${Date.now().toString(36)}_${databases.length}`
    await admin.query(`CREATE DATABASE ${name}`)
    databases.push(name)
    const target = new URL(url!)
    target.pathname = `/${name}`
    const pool = new pg.Pool({ connectionString: target.toString(), max: 4 })
    pools.push(pool)
    return pool
  }

  /** A migrated database holding one of everything the tests look at. */
  async function seeded(managedPath: string): Promise<pg.Pool> {
    const pool = await scratch()
    await applyMigrations(pool)
    await pool.query(
      `INSERT INTO "user" (id, name, email, role) VALUES ('u1', 'Ada', 'ada@example.com', 'admin')`,
    )
    await pool.query(
      `INSERT INTO session (id, token, expires_at, user_id) VALUES ('s1', 't1', now() + interval '1 day', 'u1')`,
    )
    await pool.query(
      `INSERT INTO libraries (id, name, kind, path) VALUES ($1, 'Uploads', 'managed', $2)`,
      [LIBRARY, managedPath],
    )
    await pool.query(
      `INSERT INTO models (id, library_id, path, name, slug, public_id)
       VALUES ($1, $2, 'Benchy', 'Benchy', 'benchy', 'mdbenchy01')`,
      [MODEL, LIBRARY],
    )
    await pool.query(
      `INSERT INTO model_files (id, model_id, filename, extension) VALUES ($1, $2, 'benchy.stl', 'stl')`,
      [FILE, MODEL],
    )
    // A tab, a newline and a backslash: the characters COPY has to escape.
    await pool.query(`INSERT INTO tags (id, name, slug) VALUES ($1, $2, 'boats')`, [
      TAG,
      'boats\tand\nships\\',
    ])
    await pool.query(`INSERT INTO model_tags (model_id, tag_id) VALUES ($1, $2)`, [MODEL, TAG])
    await pool.query(
      `INSERT INTO print_hosts (id, name, protocol, endpoint, credentials)
       VALUES ($1, 'Voron', 'moonraker', 'http://voron.local', $2)`,
      [PRINTER, encryptSecret('printer-api-key')],
    )
    await pool.query(`INSERT INTO settings (key, value) VALUES ('siteName', '"Workshop"')`)
    await pool.query(
      `INSERT INTO app_logs (level, source, message) VALUES ('info', 'web', 'hello')`,
    )
    return pool
  }

  async function exportTo(
    pool: pg.Pool,
    options: { includeFiles?: boolean; passphrase?: string } = {},
  ): Promise<{ file: string; manifest: BackupManifest }> {
    const file = path.join(work, `backup-${Math.random().toString(36).slice(2)}.pbbackup`)
    const manifest = await writeBackup({
      pool,
      output: createWriteStream(file),
      includeFiles: options.includeFiles ?? false,
      passphrase: options.passphrase,
      appVersion: 'test',
    })
    return { file, manifest }
  }

  const count = async (pool: pg.Pool, table: string) =>
    Number((await pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n)

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url, max: 2 })
    work = await mkdtemp(path.join(tmpdir(), 'pb-backup-'))
    process.env.BETTER_AUTH_SECRET = 'source-instance-secret'
  })

  afterEach(async () => {
    process.env.BETTER_AUTH_SECRET = 'source-instance-secret'
  })

  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.end()))
    for (const name of databases) await admin.query(`DROP DATABASE IF EXISTS ${name}`)
    await admin.end()
    await rm(work, { recursive: true, force: true })
    if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET
    else process.env.BETTER_AUTH_SECRET = originalSecret
  })

  it('lists every column that holds an encrypted credential', async () => {
    // A new `…_encrypted` or credentials column that is not in SECRET_COLUMNS
    // would be copied as ciphertext no other instance can read.
    const pool = await seeded(path.join(work, 'unused'))
    const found = await pool.query<{ name: string }>(`
      SELECT table_name || '.' || column_name AS name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (column_name ~ '(encrypted|credentials|secret_access_key)')
      ORDER BY 1`)
    expect(found.rows.map((row) => row.name)).toEqual(
      SECRET_COLUMNS.map((entry) => `${entry.table}.${entry.column}`).sort(),
    )
  })

  it('restores a backup into an empty database as an exact copy', async () => {
    const source = await seeded(path.join(work, 'managed-a', 'uploads'))
    const { file, manifest } = await exportTo(source)

    expect(manifest.tables.find((table) => table.name === 'models')?.rows).toBe(1)
    for (const excluded of EXCLUDED_TABLES) {
      expect(manifest.tables.some((table) => table.name === excluded)).toBe(false)
    }

    const target = await scratch()
    await restoreBackup({ pool: target, file, managedRoot: path.join(work, 'managed-a') })

    for (const table of manifest.tables) {
      const columns = table.columns.map((column) => `"${column}"`).join(', ')
      const query = `SELECT ${columns} FROM "${table.name}" ORDER BY 1`
      // Credentials are compared separately; they are left out without a passphrase.
      if (SECRET_COLUMNS.some((entry) => entry.table === table.name)) continue
      expect((await target.query(query)).rows, table.name).toEqual((await source.query(query)).rows)
    }

    const tag = await target.query(`SELECT name FROM tags WHERE id = $1`, [TAG])
    expect(tag.rows[0].name).toBe('boats\tand\nships\\')

    // Signed-in browsers and the source machine's logs do not come across.
    expect(await count(target, 'session')).toBe(0)
    expect(await count(target, 'app_logs')).toBe(0)

    // The constraints dropped for the load are all back.
    const keys = async (pool: pg.Pool) => {
      const client = await pool.connect()
      try {
        return await listForeignKeys(client)
      } finally {
        client.release()
      }
    }
    expect(await keys(target)).toEqual(await keys(source))
    await expect(
      target.query(`INSERT INTO model_tags (model_id, tag_id) VALUES ($1, $1)`, [LIBRARY]),
    ).rejects.toThrow(/foreign key/)

    // And the result is a database the migrator considers up to date.
    await applyMigrations(target)
    const logged = await target.query(
      `INSERT INTO app_logs (level, source, message) VALUES ('info', 'web', 'after') RETURNING id`,
    )
    expect(logged.rows[0].id).toBe(1)
  })

  it('replaces whatever the target already held', async () => {
    const source = await seeded(path.join(work, 'managed-b', 'uploads'))
    const { file } = await exportTo(source)

    const target = await seeded(path.join(work, 'managed-b', 'uploads'))
    await target.query(
      `INSERT INTO "user" (id, name, email) VALUES ('u2', 'Bob', 'bob@example.com')`,
    )
    await target.query(`DELETE FROM tags`)

    await restoreBackup({ pool: target, file, managedRoot: path.join(work, 'managed-b') })

    expect((await target.query(`SELECT id FROM "user"`)).rows).toEqual([{ id: 'u1' }])
    expect(await count(target, 'model_tags')).toBe(1)
  })

  it('leaves credentials out unless a passphrase is given', async () => {
    const source = await seeded(path.join(work, 'managed-c', 'uploads'))
    const { file, manifest } = await exportTo(source)
    expect(manifest.secrets).toBeNull()

    const target = await scratch()
    await restoreBackup({ pool: target, file, managedRoot: path.join(work, 'managed-c') })

    const printer = await target.query(`SELECT name, credentials FROM print_hosts`)
    expect(printer.rows).toEqual([{ name: 'Voron', credentials: null }])
  })

  it('carries credentials to an instance with a different secret', async () => {
    const source = await seeded(path.join(work, 'managed-d', 'uploads'))
    const { file, manifest } = await exportTo(source, { passphrase: 'correct horse' })
    expect(manifest.secrets?.count).toBe(1)

    // Nothing in the archive is readable with the source's secret alone.
    expect((await readFile(file)).includes('printer-api-key')).toBe(false)

    process.env.BETTER_AUTH_SECRET = 'a-completely-different-secret'
    const target = await scratch()
    const result = await restoreBackup({
      pool: target,
      file,
      passphrase: 'correct horse',
      managedRoot: path.join(work, 'managed-d'),
    })
    expect(result.secretsRestored).toBe(1)

    const stored = (await target.query(`SELECT credentials FROM print_hosts`)).rows[0].credentials
    expect(decryptSecret(stored)).toBe('printer-api-key')
    expect(decryptSecret(stored, 'source-instance-secret')).toBeNull()
  })

  it('refuses a wrong passphrase before changing anything', async () => {
    const source = await seeded(path.join(work, 'managed-e', 'uploads'))
    const { file } = await exportTo(source, { passphrase: 'correct horse' })

    const target = await seeded(path.join(work, 'managed-e', 'uploads'))
    await target.query(`UPDATE "user" SET name = 'Untouched'`)

    await expect(
      restoreBackup({ pool: target, file, passphrase: 'wrong', managedRoot: work }),
    ).rejects.toThrow(/passphrase/)
    expect((await target.query(`SELECT name FROM "user"`)).rows[0].name).toBe('Untouched')
  })

  it('restores uploaded files, moving the library under this instance', async () => {
    const sourceRoot = path.join(work, 'source-data', 'libraries', 'uploads')
    await mkdir(path.join(sourceRoot, 'Benchy'), { recursive: true })
    await writeFile(path.join(sourceRoot, 'Benchy', 'benchy.stl'), 'solid benchy')

    const source = await seeded(sourceRoot)
    const { file, manifest } = await exportTo(source, { includeFiles: true })
    expect(manifest.files).toMatchObject({ included: true, count: 1 })

    const targetRoot = path.join(work, 'target-data', 'libraries')
    const target = await scratch()
    const result = await restoreBackup({ pool: target, file, managedRoot: targetRoot })
    expect(result.filesRestored).toBe(1)

    const restoredPath = path.join(targetRoot, 'uploads')
    expect(await readFile(path.join(restoredPath, 'Benchy', 'benchy.stl'), 'utf8')).toBe(
      'solid benchy',
    )
    expect((await target.query(`SELECT path FROM libraries`)).rows[0].path).toBe(restoredPath)
  })

  it('restores a backup taken before later migrations, then brings it forward', async () => {
    const steps = readMigrationSteps()
    const older = steps.length - 2
    expect(older).toBeGreaterThanOrEqual(0)

    const source = await scratch()
    const client = await source.connect()
    try {
      await replayMigrations(client, steps.slice(0, older + 1))
    } finally {
      client.release()
    }
    await source.query(
      `INSERT INTO "user" (id, name, email) VALUES ('u1', 'Ada', 'ada@example.com')`,
    )
    await source.query(`INSERT INTO tags (id, name, slug) VALUES ($1, 'boats', 'boats')`, [TAG])

    const { file, manifest } = await exportTo(source)
    expect(manifest.migration.index).toBe(older)

    const target = await seeded(path.join(work, 'managed-f', 'uploads'))
    await restoreBackup({ pool: target, file, managedRoot: path.join(work, 'managed-f') })

    expect((await target.query(`SELECT name FROM tags`)).rows).toEqual([{ name: 'boats' }])
    const applied = await target.query(
      `SELECT max(created_at)::text AS at FROM drizzle.__drizzle_migrations`,
    )
    expect(Number(applied.rows[0].at)).toBe(steps.at(-1)!.when)
  })

  it('leaves the target untouched when the load fails part-way', async () => {
    const steps = readMigrationSteps()
    const file = await craft(
      {
        formatVersion: 1,
        appVersion: 'test',
        createdAt: new Date().toISOString(),
        migration: { when: steps.at(-1)!.when, index: steps.length - 1 },
        // The first table loads; the second is not what the manifest promised.
        tables: [
          { name: 'tags', columns: ['id', 'name', 'slug'], rows: 1 },
          { name: 'user', columns: ['id', 'name', 'email'], rows: 2 },
        ],
        libraries: [],
        files: { included: false, count: 0, bytes: 0 },
        secrets: null,
      },
      {
        [tableEntry('tags')]: `${TAG}\tboats\tboats\n`,
        [tableEntry('user')]: `u9\tMallory\tmallory@example.com\n`,
      },
    )

    const target = await seeded(path.join(work, 'managed-g', 'uploads'))
    await expect(restoreBackup({ pool: target, file, managedRoot: work })).rejects.toThrow(
      /damaged/,
    )

    expect((await target.query(`SELECT id FROM "user"`)).rows).toEqual([{ id: 'u1' }])
    expect(await count(target, 'models')).toBe(1)
    expect(await count(target, 'session')).toBe(1)
  })

  it('refuses a backup from a newer version', async () => {
    const steps = readMigrationSteps()
    const file = await craft({
      formatVersion: 1,
      appVersion: '99.0.0',
      createdAt: new Date().toISOString(),
      migration: { when: steps.at(-1)!.when + 1, index: steps.length },
      tables: [],
      libraries: [],
      files: { included: false, count: 0, bytes: 0 },
      secrets: null,
    })
    await expect(openBackup(file)).rejects.toThrow(/newer PrintBench/)
  })

  it('refuses a file that tries to write outside its library', async () => {
    const steps = readMigrationSteps()
    const manifest: BackupManifest = {
      formatVersion: 1,
      appVersion: 'test',
      createdAt: new Date().toISOString(),
      migration: { when: steps.at(-1)!.when, index: steps.length - 1 },
      tables: [],
      libraries: [{ id: LIBRARY, name: 'Uploads', kind: 'managed', backend: 'local', path: '/x' }],
      files: { included: true, count: 1, bytes: 1 },
      secrets: null,
    }

    // A library the manifest does not list.
    const stray = await craft(manifest, { [`files/${MODEL}/benchy.stl`]: 'x' })
    await expect(openBackup(stray)).rejects.toBeInstanceOf(BackupError)

    // A name SQL would have to quote.
    const hostile = await craft({
      ...manifest,
      tables: [{ name: 'tags"; DROP TABLE models; --', columns: ['id'], rows: 0 }],
    } as BackupManifest)
    await expect(openBackup(hostile)).rejects.toBeInstanceOf(BackupError)

    await expect(openBackup(path.join(work, 'does-not-exist'))).rejects.toBeInstanceOf(BackupError)
    const junk = path.join(work, 'junk.pbbackup')
    await writeFile(junk, 'not a zip at all')
    await expect(openBackup(junk)).rejects.toBeInstanceOf(BackupError)
  })

  /** Builds an archive by hand, to test what a hostile or damaged upload does. */
  async function craft(
    manifest: BackupManifest,
    entries: Record<string, string> = {},
  ): Promise<string> {
    const file = path.join(work, `crafted-${Math.random().toString(36).slice(2)}.pbbackup`)
    const output = createWriteStream(file)
    const archive = new ZipArchive({ zlib: { level: 1 } })
    archive.pipe(output)
    for (const [name, content] of Object.entries(entries)) archive.append(content, { name })
    archive.append(JSON.stringify(manifest), { name: MANIFEST_ENTRY })
    await archive.finalize()
    await finished(output)
    return file
  }
})
