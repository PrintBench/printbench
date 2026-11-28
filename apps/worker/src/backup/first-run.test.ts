// @covers BACKUP-002
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { format } from 'node:util'
import pg from 'pg'
import {
  BACKUP_FIRST_RUN_SUBJECT,
  BACKUP_TICKET_HEADER,
  LocalAdapter,
  backupObjectName,
  backupUserSubject,
  createBackupKeyPair,
  createEncryptingStream,
  signBackupTicket,
  type LibraryLocation,
} from '@pb/core'
import { closeDb } from '@pb/db'
import { applyMigrations } from '@pb/db/migrations'
import { writeBackup } from './export'
import { createBackupHandler } from './http'
import { BACKUP_FORMAT_VERSION } from './manifest'
import { currentMigration } from './tables'

/**
 * Restoring a new server straight from the old one's bucket.
 *
 * A brand-new server has no S3 connection, so the first-run screen sends the
 * bucket and its credentials with the fetch. They must reach the bucket and
 * go nowhere else — not the restore state on disk, not the log — and they
 * must only be accepted while the instance has no accounts.
 *
 * A file of its own because the first-run ticket only works on a database
 * with no accounts, and the database the worker uses is fixed per process:
 * this one points it at an empty scratch database before anything opens it.
 * The bucket is a local folder standing in for S3, opened by the handler's
 * own `openBucket` hook so the location the request built is still checked.
 */

const url = process.env.DATABASE_URL
const SECRET = 'first-run-restore-test-secret'
const PASSPHRASE = 'first run restore passphrase'
const OLD_INSTANCE = '7a000000-0000-4000-8000-000000000001'
const OLD_ADMIN = 'first-run-old-admin'
const SOURCE = {
  bucket: 'old-server-backups',
  endpoint: 'http://s3.example.test:9000',
  region: 'eu-west-1',
  accessKeyId: 'FIRSTRUNACCESSKEY',
  secretAccessKey: 'first-run-secret-access-key',
  prefix: 'printbench-backups',
}

describe('first-run restore from a bucket', { tags: ['integration'] }, () => {
  let admin: pg.Pool
  const pools: pg.Pool[] = []
  const databases: string[] = []
  let work = ''
  let staging = ''
  let bucket = ''
  let backupPath = ''
  let server: Server
  let base = ''
  const opened: LibraryLocation[] = []
  const logged: string[] = []

  async function scratch(): Promise<{ pool: pg.Pool; url: string }> {
    const name = `pb_first_run_test_${Date.now().toString(36)}_${databases.length}`
    await admin.query(`CREATE DATABASE ${name}`)
    databases.push(name)
    const target = new URL(url!)
    target.pathname = `/${name}`
    const pool = new pg.Pool({ connectionString: target.toString(), max: 2 })
    pools.push(pool)
    await applyMigrations(pool)
    return { pool, url: target.toString() }
  }

  const ticketFor = (subject: string) =>
    new URLSearchParams({ ...signBackupTicket(SECRET, 'backup-restore', subject) }).toString()

  const post = (route: string, body: unknown, ticket = ticketFor(BACKUP_FIRST_RUN_SUBJECT)) =>
    fetch(`${base}/api/backup/restore/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [BACKUP_TICKET_HEADER]: ticket },
      body: JSON.stringify(body),
    })

  const staged = async () =>
    (await readdir(staging)).filter((name) => name.startsWith('upload-')).sort()

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url, max: 2 })
    work = await mkdtemp(path.join(tmpdir(), 'pb-first-run-'))
    staging = path.join(work, 'staging')
    bucket = path.join(work, 'bucket')
    vi.stubEnv('DATA_DIR', work)
    vi.stubEnv('BETTER_AUTH_SECRET', SECRET)

    // The old server: one admin account, backed up to its bucket on a schedule.
    const old = await scratch()
    await old.pool.query(
      `INSERT INTO "user" (id, name, email, role) VALUES ($1, 'Old Admin', 'old-admin@example.test', 'admin')`,
      [OLD_ADMIN],
    )
    const client = await old.pool.connect()
    const migration = await currentMigration(client).finally(() => client.release())
    const envelope = createEncryptingStream(createBackupKeyPair(PASSPHRASE), {
      createdAt: new Date().toISOString(),
      appVersion: 'test',
      backupFormat: BACKUP_FORMAT_VERSION,
      migration,
    })
    const name = backupObjectName(new Date())
    backupPath = `${OLD_INSTANCE}/${name}`
    await mkdir(path.join(bucket, SOURCE.prefix, OLD_INSTANCE), { recursive: true })
    const output = new PassThrough()
    await Promise.all([
      pipeline(
        output,
        envelope.stream,
        createWriteStream(path.join(bucket, SOURCE.prefix, backupPath)),
      ),
      writeBackup({ pool: old.pool, output, includeFiles: false, secretsKey: envelope.secretsKey }),
    ])

    // The new server: migrated, no accounts. The worker's pool opens on first use.
    const fresh = await scratch()
    vi.stubEnv('DATABASE_URL', fresh.url)

    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(format(...args))
      })
    }

    const handler = createBackupHandler({
      directory: staging,
      pause: async () => undefined,
      resume: async () => undefined,
      openBucket: (location) => {
        opened.push(location)
        return new LocalAdapter({
          id: 'bucket',
          kind: 'in_place',
          backend: 'local',
          allowWrites: false,
          path: path.join(bucket, location.s3Prefix ?? ''),
        })
      },
    })
    server = createServer((request, response) => void handler.handle(request, response))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    server?.close()
    await closeDb()
    await Promise.all(pools.map((pool) => pool.end()))
    for (const name of databases) {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    }
    await admin.end()
    await rm(work, { recursive: true, force: true })
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  }, 120_000)

  it('restores a backup from a typed-in bucket, keeping its credentials out of everything it writes', async () => {
    // Only names a schedule writes: the typed-in bucket is no way to read anything else.
    const elsewhere = await post('fetch', { path: '../../etc/passwd', source: SOURCE })
    expect(elsewhere.status).toBe(400)

    // Backing out of a fetched backup leaves nothing behind.
    const first = await post('fetch', { path: backupPath, source: SOURCE })
    expect(first.status).toBe(200)
    const { id: abandoned } = (await first.json()) as { id: string }
    expect(await staged()).toEqual([`upload-${abandoned}.encrypted`])
    expect((await post('discard', { id: abandoned })).status).toBe(200)
    expect(await staged()).toEqual([])

    const fetched = await post('fetch', { path: backupPath, source: SOURCE })
    const { id, locked } = (await fetched.json()) as { id: string; locked?: { appVersion: string } }
    expect(locked?.appVersion).toBe('test')

    // The bucket was opened as typed, and read-only.
    expect(opened.at(-1)).toMatchObject({
      backend: 's3',
      allowWrites: false,
      s3Bucket: SOURCE.bucket,
      s3Endpoint: SOURCE.endpoint,
      s3Region: SOURCE.region,
      s3AccessKeyId: SOURCE.accessKeyId,
      s3SecretAccessKey: SOURCE.secretAccessKey,
      s3Prefix: SOURCE.prefix,
    })

    expect((await post('unlock', { id, passphrase: PASSPHRASE })).status).toBe(200)
    expect((await post('apply', { id, passphrase: PASSPHRASE })).status).toBe(202)

    const ticket = ticketFor(BACKUP_FIRST_RUN_SUBJECT)
    await vi.waitFor(
      async () => {
        const status = await fetch(`${base}/api/backup/restore/status`, {
          headers: { [BACKUP_TICKET_HEADER]: ticket },
        })
        expect(((await status.json()) as { status: string }).status).toBe('done')
      },
      { timeout: 20_000, interval: 200 },
    )

    // The new server now holds the old one's account.
    const restored = await pools[1]!.query(`SELECT id FROM "user"`)
    expect(restored.rows).toEqual([{ id: OLD_ADMIN }])

    // Nothing staged is left, and nothing the worker wrote or logged holds the credentials.
    expect(await staged()).toEqual([])
    const written = await Promise.all(
      (await readdir(staging)).map((name) => readFile(path.join(staging, name), 'utf8')),
    )
    for (const text of [...written, ...logged]) {
      expect(text).not.toContain(SOURCE.secretAccessKey)
      expect(text).not.toContain(SOURCE.accessKeyId)
    }
  })

  it('closes the typed-in bucket once an account exists', async () => {
    // The restore above brought an account back, so first-run is over.
    const firstRun = await post('fetch', { path: backupPath, source: SOURCE })
    expect(firstRun.status).toBe(403)

    // An admin restores from the bucket the schedule names, never one typed in.
    const asAdmin = await post(
      'fetch',
      { path: backupPath, source: SOURCE },
      ticketFor(backupUserSubject(OLD_ADMIN)),
    )
    expect(asAdmin.status).toBe(403)
    expect(await staged()).toEqual([])
  })
})
