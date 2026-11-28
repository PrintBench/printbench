// @covers BACKUP-002
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { inArray, sql } from 'drizzle-orm'
import { createDb, schema } from '@pb/db'
import { createS3Connection, deleteS3Connection } from '../services/s3-connection-service'
import { createS3Library } from '../services/library-settings-service'
import type { LibraryLocation } from '../storage/types'
import {
  backupDue,
  backupLocation,
  checkBackupPassphrase,
  getBackupSchedule,
  removeBackupSchedule,
  saveBackupSchedule,
  type BackupScheduleInput,
  type BackupWriteCheck,
} from './schedule-service'

/**
 * The rules over the stored backup schedule: backups get a prefix nobody else
 * uses, a key that only the passphrase opens, and a bucket that cannot be
 * removed from under them.
 *
 * No bucket is involved. The write check is injected and records what it was
 * asked, so "nothing is saved when the bucket refuses" can be said directly.
 */

const SECRET = 'backup-schedule-test-secret'
const NAME = 'Backup schedule test'
const PASSPHRASE = 'a long and memorable passphrase'

describe('backup schedule', { tags: ['integration'] }, () => {
  let pool: ReturnType<typeof createDb>['pool']
  let db: ReturnType<typeof createDb>['db']
  let connectionId = ''
  let otherConnectionId = ''
  let checked: LibraryLocation[] = []
  let refuse: string | null = null

  const check: BackupWriteCheck = async (location) => {
    checked.push(location)
    return refuse ? { ok: false, reason: refuse } : { ok: true }
  }
  const noCheck = async () => ({ ok: true as const })

  const input = (overrides: Partial<BackupScheduleInput> = {}): BackupScheduleInput => ({
    enabled: true,
    s3ConnectionId: connectionId,
    prefix: 'printbench-backups',
    cron: '30 2 * * *',
    keep: 7,
    passphrase: PASSPHRASE,
    ...overrides,
  })

  async function cleanup() {
    await removeBackupSchedule(db)
    await db.delete(schema.backupRuns)
    const ours = await db
      .select({ id: schema.s3Connections.id })
      .from(schema.s3Connections)
      .where(sql`${schema.s3Connections.name} LIKE ${NAME + '%'}`)
    const ids = ours.map((row) => row.id)
    if (ids.length === 0) return
    await db.delete(schema.libraries).where(inArray(schema.libraries.s3ConnectionId, ids))
    await db.delete(schema.s3Connections).where(inArray(schema.s3Connections.id, ids))
  }

  beforeAll(async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', SECRET)
    ;({ pool, db } = createDb())
    await cleanup()

    const made = await createS3Connection(
      db,
      { name: `${NAME} main`, bucket: 'shared-bucket', accessKeyId: 'AKIA', secretAccessKey: 's' },
      { check: noCheck },
    )
    const other = await createS3Connection(
      db,
      { name: `${NAME} other`, bucket: 'backup-bucket', accessKeyId: 'AKIA', secretAccessKey: 's' },
      { check: noCheck },
    )
    if (!made.ok || !other.ok) throw new Error('could not create connections')
    connectionId = made.data.id
    otherConnectionId = other.data.id

    const library = await createS3Library(
      db,
      {
        name: `${NAME} models`,
        kind: 'in_place',
        connectionId,
        prefix: 'models',
        groupingMode: 'deepest',
        writeSidecar: false,
      },
      { check: noCheck },
    )
    if (!library.ok) throw new Error(library.error)
  })

  afterAll(async () => {
    await cleanup()
    await pool.end()
    vi.unstubAllEnvs()
  })

  beforeEach(async () => {
    await removeBackupSchedule(db)
    await db.delete(schema.backupRuns)
    checked = []
    refuse = null
  })

  it('needs a passphrase the first time, and keeps only a key sealed under it', async () => {
    const without = await saveBackupSchedule(db, input({ passphrase: null }), check)
    expect(without.ok).toBe(false)
    expect(await getBackupSchedule(db)).toBeNull()

    const saved = await saveBackupSchedule(db, input(), check)
    expect(saved.ok).toBe(true)

    // The passphrase itself is nowhere in the row.
    const row = await db.select().from(schema.backupSchedule)
    expect(JSON.stringify(row)).not.toContain(PASSPHRASE)
    expect(await checkBackupPassphrase(db, PASSPHRASE)).toBe(true)
    expect(await checkBackupPassphrase(db, `${PASSPHRASE}!`)).toBe(false)
  })

  it.each([
    ['the library’s own prefix', 'models'],
    ['a folder inside the library', 'models/backups'],
    ['the whole bucket', ''],
  ])('refuses %s, which a library already indexes', async (_label, prefix) => {
    const saved = await saveBackupSchedule(db, input({ prefix }), check)
    expect(saved.ok).toBe(false)
    expect(checked).toEqual([])
    expect(await getBackupSchedule(db)).toBeNull()
  })

  it('accepts a prefix beside the library, and the same prefix in another bucket', async () => {
    expect((await saveBackupSchedule(db, input({ prefix: 'models-backups' }), check)).ok).toBe(true)
    expect(
      (
        await saveBackupSchedule(
          db,
          input({ s3ConnectionId: otherConnectionId, prefix: 'models', passphrase: null }),
          check,
        )
      ).ok,
    ).toBe(true)
    expect((await getBackupSchedule(db))?.bucket).toBe('backup-bucket')
  })

  it('saves nothing when the bucket refuses a write, and checks where backups will go', async () => {
    refuse = 'The key cannot write or delete here.'
    const saved = await saveBackupSchedule(db, input(), check)
    expect(saved).toEqual({ ok: false, error: refuse })
    expect(await getBackupSchedule(db)).toBeNull()
    expect(checked.map((location) => [location.s3Bucket, location.s3Prefix])).toEqual([
      ['shared-bucket', 'printbench-backups'],
    ])

    // And the location the worker writes to is the same place, writable.
    refuse = null
    await saveBackupSchedule(db, input(), check)
    const location = await backupLocation(db)
    expect(location.ok && [location.data.s3Prefix, location.data.allowWrites]).toEqual([
      'printbench-backups',
      true,
    ])
  })

  it('makes a new key for a new passphrase, which the old one no longer opens', async () => {
    const first = await saveBackupSchedule(db, input(), check)
    const kept = await saveBackupSchedule(db, input({ keep: 3, passphrase: null }), check)
    const changed = await saveBackupSchedule(
      db,
      input({ passphrase: 'an entirely different phrase' }),
      check,
    )
    if (!first.ok || !kept.ok || !changed.ok) throw new Error('save failed')

    expect(kept.data.keyId).toBe(first.data.keyId)
    expect(changed.data.keyId).not.toBe(first.data.keyId)
    expect(await checkBackupPassphrase(db, PASSPHRASE)).toBe(false)
    expect(await checkBackupPassphrase(db, 'an entirely different phrase')).toBe(true)
  })

  it('will not let the connection backups use be removed', async () => {
    await saveBackupSchedule(db, input({ s3ConnectionId: otherConnectionId }), check)
    const removed = await deleteS3Connection(db, otherConnectionId)
    expect(removed.ok).toBe(false)
    expect(await getBackupSchedule(db)).not.toBeNull()
  })

  it('is due once a scheduled time passes, and not again until the next', async () => {
    await saveBackupSchedule(db, input({ cron: '30 2 * * *' }), check)
    const now = new Date()
    expect(await backupDue(db, now)).toBe(false)

    const tomorrow = new Date(now.getTime() + 26 * 60 * 60 * 1000)
    expect(await backupDue(db, tomorrow)).toBe(true)

    await db.insert(schema.backupRuns).values({ trigger: 'schedule', startedAt: tomorrow })
    expect(await backupDue(db, new Date(tomorrow.getTime() + 60_000))).toBe(false)

    // Paused means never, however long it has been.
    await saveBackupSchedule(db, input({ enabled: false, passphrase: null }), check)
    expect(await backupDue(db, new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000))).toBe(false)
  })
})
