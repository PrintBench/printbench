import { Transform, type TransformCallback } from 'node:stream'
import { eq } from 'drizzle-orm'
import type pg from 'pg'
import {
  backupLocation,
  backupObjectName,
  backupsToPrune,
  createEncryptingStream,
  createStorageAdapter,
  describeS3Error,
  getBackupKeys,
  getBackupSchedule,
  getInstanceId,
  recordAudit,
  SYSTEM_ACTOR,
  type AuditActor,
  type StorageAdapter,
} from '@pb/core'
import { schema, type Database } from '@pb/db'
import { writeBackup } from './export'
import { BACKUP_FORMAT_VERSION } from './manifest'
import { currentMigration } from './tables'

/**
 * Writes one encrypted backup to the bucket, then prunes old ones.
 *
 * The same export as a download, minus library files, streamed through the
 * envelope and straight into a multipart upload: nothing is staged on disk
 * and memory stays at a few upload parts however large the database is.
 *
 * Pruning runs only after the new backup has been written and is visible in
 * the listing, so a failing bucket never costs the backups already in it.
 *
 * Everything happens inside this instance's own folder under the prefix,
 * `<instance id>/`. Another instance sharing the prefix has a folder of its
 * own, which this never lists, so it can never prune that instance's backups.
 */

export interface BucketBackupOptions {
  pool: pg.Pool
  db: Database
  trigger: 'schedule' | 'manual'
  requestedBy?: { id: string; name: string }
  appVersion?: string
  /** The schedule's prefix. Defaults to its bucket; tests pass a folder. */
  storage?: StorageAdapter
}

export type BucketBackupResult =
  | { status: 'skipped'; reason: string }
  | { status: 'succeeded'; runId: string; name: string; bytes: number; pruned: string[] }
  | { status: 'failed'; runId: string; error: string }

export async function runBucketBackup(options: BucketBackupOptions): Promise<BucketBackupResult> {
  const { db, pool } = options
  const [schedule, keys] = await Promise.all([getBackupSchedule(db), getBackupKeys(db)])
  // Turned off between the job being queued and it starting.
  if (!schedule || !keys) return { status: 'skipped', reason: 'Scheduled backups are not set up.' }
  if (options.trigger === 'schedule' && !schedule.enabled) {
    return { status: 'skipped', reason: 'Scheduled backups are paused.' }
  }

  /*
   * One backup runs at a time (see JOB_OPTIONS), so a run still marked as
   * running is one a stopped worker never finished. Its upload was aborted
   * with it; only the record is left to correct.
   */
  await db
    .update(schema.backupRuns)
    .set({
      status: 'failed',
      finishedAt: new Date(),
      error: 'Interrupted: the worker stopped before this backup finished.',
    })
    .where(eq(schema.backupRuns.status, 'running'))

  const [run] = await db
    .insert(schema.backupRuns)
    .values({
      trigger: options.trigger,
      keyId: keys.keyId,
      requestedBy: options.requestedBy?.name ?? null,
    })
    .returning({ id: schema.backupRuns.id })
  const runId = run!.id
  const actor: AuditActor = options.requestedBy
    ? { type: 'user', id: options.requestedBy.id, name: options.requestedBy.name }
    : SYSTEM_ACTOR

  let storage = options.storage
  let ownStorage = false
  try {
    if (!storage) {
      const location = await backupLocation(db)
      if (!location.ok) throw new Error(location.error)
      storage = createStorageAdapter(location.data)
      ownStorage = true
    }

    const folder = await getInstanceId(db)
    const createdAt = new Date()
    const name = backupObjectName(createdAt)
    const key = `${folder}/${name}`
    const client = await pool.connect()
    let migration: Awaited<ReturnType<typeof currentMigration>>
    try {
      migration = await currentMigration(client)
    } finally {
      client.release()
    }

    const envelope = createEncryptingStream(keys, {
      createdAt: createdAt.toISOString(),
      appVersion: options.appVersion ?? null,
      backupFormat: BACKUP_FORMAT_VERSION,
      migration,
    })
    const counter = new ByteCounter()
    envelope.stream.on('error', (error) => counter.destroy(error))
    /*
     * Failures are reported through the two promises below. Without a
     * listener of its own, an upload that gives up before reading a byte
     * leaves the counter's error with nobody to hear it — an uncaught
     * exception, which takes the whole worker down with it.
     */
    counter.on('error', () => undefined)
    envelope.stream.pipe(counter)

    /*
     * Two halves that must fail together. If the upload fails, the export is
     * left writing into a stream nobody reads and would wait forever; if the
     * export fails, the upload must not complete a truncated object.
     */
    const upload = storage.write(key, counter).catch((error: unknown) => {
      envelope.stream.destroy(error as Error)
      throw error
    })
    const exported = writeBackup({
      pool,
      output: envelope.stream,
      includeFiles: false,
      secretsKey: envelope.secretsKey,
      appVersion: options.appVersion,
    }).catch((error: unknown) => {
      counter.destroy(error as Error)
      throw error
    })
    const [exportResult, uploadResult] = await Promise.allSettled([exported, upload])
    if (uploadResult.status === 'rejected') throw uploadResult.reason
    if (exportResult.status === 'rejected') throw exportResult.reason
    const manifest = exportResult.value

    // The header was written before the transaction began. A migration
    // landing in between would make it describe a different schema.
    if (manifest.migration.when !== migration.when) {
      await storage.remove(key).catch(() => undefined)
      throw new Error(
        'The database was upgraded while the backup ran. The next one will be taken as usual.',
      )
    }

    // Only this instance's folder, and only names in it.
    const listed = (await storage.list(folder))
      .filter((entry) => !entry.isDirectory)
      .map((entry) => entry.path.slice(folder.length + 1))
    const prune = backupsToPrune(listed, schedule.keep, name)
    const pruned: string[] = []
    for (const old of prune) {
      try {
        await storage.remove(`${folder}/${old}`)
        pruned.push(old)
      } catch (error) {
        console.warn(`[backup] could not remove old backup ${old}: ${String(error)}`)
      }
    }

    await db
      .update(schema.backupRuns)
      .set({
        status: 'succeeded',
        finishedAt: new Date(),
        objectName: key,
        bytes: counter.bytes,
        pruned: pruned.length,
      })
      .where(eq(schema.backupRuns.id, runId))
    await recordAudit(db, {
      action: 'backup.uploaded',
      actor,
      detail: {
        name: key,
        bytes: counter.bytes,
        rows: manifest.tables.reduce((total, table) => total + table.rows, 0),
        photos: manifest.photos.count,
        credentials: manifest.secrets?.count ?? 0,
        pruned: pruned.length,
        key: keys.keyId,
      },
    })
    console.log(
      `[backup] wrote ${key} (${counter.bytes} bytes) to ${schedule.bucket}/${schedule.prefix}` +
        (pruned.length > 0 ? `, removed ${pruned.length} older` : ''),
    )
    return { status: 'succeeded', runId, name: key, bytes: counter.bytes, pruned }
  } catch (error) {
    const message = describeFailure(error, schedule.bucket)
    console.error('[backup] backup to S3 failed:', error)
    await db
      .update(schema.backupRuns)
      .set({ status: 'failed', finishedAt: new Date(), error: message })
      .where(eq(schema.backupRuns.id, runId))
    await recordAudit(db, {
      action: 'backup.upload_failed',
      actor,
      outcome: 'failure',
      detail: { error: message },
    })
    return { status: 'failed', runId, error: message }
  } finally {
    if (ownStorage) (storage as { destroy?: () => void } | undefined)?.destroy?.()
  }
}

function describeFailure(error: unknown, bucket: string): string {
  // An SDK or network error carries $metadata or a code; anything else is
  // ours and already readable.
  const shaped = error as { $metadata?: unknown; code?: unknown } | null
  if (shaped?.$metadata !== undefined || typeof shaped?.code === 'string') {
    return describeS3Error(error, bucket)
  }
  const message = error instanceof Error ? error.message.trim() : ''
  return message || 'The backup failed. The worker log has the details.'
}

class ByteCounter extends Transform {
  bytes = 0

  override _transform(chunk: Buffer, _encoding: string, done: TransformCallback) {
    this.bytes += chunk.length
    done(null, chunk)
  }
}
