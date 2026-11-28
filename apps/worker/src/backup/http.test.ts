// @covers BACKUP-002
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { PassThrough } from 'node:stream'
import {
  BACKUP_TICKET_HEADER,
  backupUserSubject,
  createBackupKeyPair,
  createEncryptingStream,
  signBackupTicket,
} from '@pb/core'
import { closeDb, getPool } from '@pb/db'
import { writeBackup } from './export'
import { createBackupHandler } from './http'
import { BACKUP_FORMAT_VERSION } from './manifest'
import { currentMigration } from './tables'

/**
 * Backing out of a restore leaves nothing behind.
 *
 * A staged backup is the whole instance's data, and once unlocked it is
 * plaintext on the data volume. Cancelling must remove every file the restore
 * staged, and an upload abandoned without a cancel must not outlive the
 * worker's age limit. Driven over HTTP, the way the browser drives it.
 *
 * Nothing is restored, so the shared database is only read, apart from the
 * one admin account the tickets name.
 */

const SECRET = 'backup-http-test-secret'
const ADMIN = 'backup-http-test-admin'
const PASSPHRASE = 'http test backup passphrase'

describe('restore staging', { tags: ['integration'] }, () => {
  let work = ''
  let staging = ''
  let encrypted: Buffer
  let server: Server
  let base = ''
  let ticket = ''

  async function start(directory: string) {
    const handler = createBackupHandler({
      directory,
      pause: async () => undefined,
      resume: async () => undefined,
    })
    const started = createServer((request, response) => void handler.handle(request, response))
    await new Promise<void>((resolve) => started.listen(0, '127.0.0.1', resolve))
    return { server: started, base: `http://127.0.0.1:${(started.address() as AddressInfo).port}` }
  }

  const post = (route: string, body: string | Uint8Array, type = 'application/json') =>
    fetch(`${base}/api/backup/restore/${route}`, {
      method: 'POST',
      headers: { 'content-type': type, [BACKUP_TICKET_HEADER]: ticket },
      body,
    })

  const staged = async () =>
    (await readdir(staging)).filter((name) => name.startsWith('upload-')).sort()

  beforeAll(async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', SECRET)
    work = await mkdtemp(path.join(tmpdir(), 'pb-backup-http-'))
    vi.stubEnv('DATA_DIR', work)
    staging = path.join(work, 'staging')

    const pool = getPool()
    await pool.query(
      `INSERT INTO "user" (id, name, email, role) VALUES ($1, 'Restore Tester', 'restore-tester@example.test', 'admin')
       ON CONFLICT (id) DO NOTHING`,
      [ADMIN],
    )
    ticket = new URLSearchParams({
      ...signBackupTicket(SECRET, 'backup-restore', backupUserSubject(ADMIN)),
    }).toString()

    // A real encrypted backup of the shared database, as a schedule writes one.
    const client = await pool.connect()
    const migration = await currentMigration(client).finally(() => client.release())
    const envelope = createEncryptingStream(createBackupKeyPair(PASSPHRASE), {
      createdAt: new Date().toISOString(),
      appVersion: 'test',
      backupFormat: BACKUP_FORMAT_VERSION,
      migration,
    })
    const file = path.join(work, 'backup.encrypted.pbbackup')
    const output = new PassThrough()
    await Promise.all([
      pipeline(output, envelope.stream, createWriteStream(file)),
      writeBackup({ pool, output, includeFiles: false, secretsKey: envelope.secretsKey }),
    ])
    encrypted = await readFile(file)
    ;({ server, base } = await start(staging))
  })

  afterAll(async () => {
    server?.close()
    await getPool().query(`DELETE FROM "user" WHERE id = $1`, [ADMIN])
    await closeDb()
    await rm(work, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('removes the upload and its decrypted copy when the restore is cancelled', async () => {
    const uploaded = await post('upload', new Uint8Array(encrypted), 'application/octet-stream')
    const { id, locked } = (await uploaded.json()) as { id: string; locked?: unknown }
    expect(locked).toBeTruthy()

    const unlocked = await post('unlock', JSON.stringify({ id, passphrase: PASSPHRASE }))
    expect(unlocked.status).toBe(200)
    // Decrypted and waiting for confirmation: the plaintext is on disk now.
    expect(await staged()).toEqual([`upload-${id}.envelope`, `upload-${id}.pbbackup`])

    const discarded = await post('discard', JSON.stringify({ id }))
    expect(discarded.status).toBe(200)
    expect(await staged()).toEqual([])

    const status = await fetch(`${base}/api/backup/restore/status`, {
      headers: { [BACKUP_TICKET_HEADER]: ticket },
    })
    expect(((await status.json()) as { status: string }).status).toBe('idle')
  })

  it('removes an upload cancelled before it was unlocked', async () => {
    const uploaded = await post('upload', new Uint8Array(encrypted), 'application/octet-stream')
    const { id } = (await uploaded.json()) as { id: string }
    const wrong = await post('unlock', JSON.stringify({ id, passphrase: 'not the passphrase' }))
    expect(wrong.status).toBe(400)
    expect(await staged()).toEqual([`upload-${id}.encrypted`])

    await post('discard', JSON.stringify({ id }))
    expect(await staged()).toEqual([])
  })

  it('sweeps an abandoned upload once it has sat untouched past the limit', async () => {
    const directory = path.join(work, 'abandoned')
    const { server: first } = await start(directory)
    first.close()

    const old = path.join(directory, 'upload-00000000-0000-4000-8000-000000000001.pbbackup')
    const recent = path.join(directory, 'upload-00000000-0000-4000-8000-000000000002.encrypted')
    await writeFile(old, 'plaintext rows')
    await writeFile(recent, 'still arriving')
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await utimes(old, twoHoursAgo, twoHoursAgo)

    // As after a worker restart: the sweep runs when the handler starts.
    const { server: second } = await start(directory)
    await vi.waitFor(async () => {
      expect((await readdir(directory)).filter((name) => name.startsWith('upload-'))).toEqual([
        path.basename(recent),
      ])
    })
    second.close()
  })
})
