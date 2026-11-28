import { CronExpressionParser } from 'cron-parser'
import { desc, eq, sql } from 'drizzle-orm'
import type { Database } from '@pb/db'
import { schema } from '@pb/db'
import { isScanDue, nextRun } from '../scan/schedule-presets'
import {
  loadS3ConnectionForCheck,
  normalizeS3Prefix,
  s3CheckLocation,
  type ServiceResult,
} from '../services/s3-connection-service'
import { createStorageAdapter } from '../storage/factory'
import { describeS3Error } from '../storage/s3-adapter'
import type { LibraryLocation } from '../storage/types'
import {
  BACKUP_PASSPHRASE_MIN_LENGTH,
  createBackupKeyPair,
  openBackupKey,
  type SealedBackupKey,
} from './envelope'
import { BACKUP_KEEP_MAX, BACKUP_KEEP_MIN, s3PrefixesOverlap } from './retention'

/**
 * The instance's backup schedule: which bucket, how often, how many to keep,
 * and the key backups are encrypted for.
 *
 * Read and written by the web tier, acted on by the worker. Both go through
 * here so the rules — a prefix of its own, a key nobody can read without the
 * passphrase — hold whichever side is asking.
 */

/** What the UI offers. Cron underneath, in the server's local time. */
export const BACKUP_SCHEDULE_PRESETS = [
  { cron: '30 2 * * *', label: 'Daily', hint: 'Every night at 02:30.' },
  { cron: '30 2 * * 0', label: 'Weekly', hint: 'Sunday at 02:30.' },
  { cron: '30 */12 * * *', label: 'Twice a day', hint: 'At 00:30 and 12:30.' },
] as const

/** A backup reads every table. More often than hourly would gain nothing. */
const BACKUP_MIN_INTERVAL_MS = 60 * 60 * 1000

/** A name in the prefix that a backup can never have. */
const WRITE_CHECK_NAME = '.printbench-write-check'

export interface BackupScheduleSummary {
  enabled: boolean
  s3ConnectionId: string
  connectionName: string
  bucket: string
  prefix: string
  cron: string
  keep: number
  keyId: string
  keyCreatedAt: Date
  nextRunAt: Date | null
}

export interface BackupScheduleInput {
  enabled: boolean
  s3ConnectionId: string
  prefix: string
  cron: string
  keep: number
  /**
   * Required the first time. Given again, it makes a new key: backups from
   * then on need the new passphrase, and older ones still need the old one.
   */
  passphrase?: string | null
}

export interface BackupRunSummary {
  id: string
  trigger: 'schedule' | 'manual'
  status: 'running' | 'succeeded' | 'failed'
  startedAt: Date
  finishedAt: Date | null
  objectName: string | null
  bytes: number | null
  pruned: number
  keyId: string | null
  error: string | null
  requestedBy: string | null
}

/** Whether this location accepts a write and a delete. Injected in tests. */
export type BackupWriteCheck = (
  location: LibraryLocation,
) => Promise<{ ok: true } | { ok: false; reason: string }>

export const checkBackupWrite: BackupWriteCheck = async (location) => {
  const storage = createStorageAdapter(location)
  try {
    await storage.write(WRITE_CHECK_NAME, 'PrintBench checks it can write here before saving.')
    await storage.remove(WRITE_CHECK_NAME)
    return { ok: true }
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode
    const name = (error as { name?: string })?.name
    if (name === 'AccessDenied' || status === 403) {
      return {
        ok: false,
        reason:
          'The key cannot write or delete here. Backups need PutObject, DeleteObject and ListBucket on this prefix.',
      }
    }
    return { ok: false, reason: describeS3Error(error, location.s3Bucket ?? '') }
  } finally {
    ;(storage as { destroy?: () => void }).destroy?.()
  }
}

/** Why a backup schedule is unacceptable, or null. */
export function backupCronProblem(cron: string): string | null {
  const trimmed = cron.trim()
  if (!trimmed) return 'Choose how often to back up.'
  try {
    const interval = CronExpressionParser.parse(trimmed)
    const first = interval.next().toDate().getTime()
    const second = interval.next().toDate().getTime()
    if (second - first < BACKUP_MIN_INTERVAL_MS) return 'Back up at most once an hour.'
  } catch {
    return 'That is not a schedule this understands. Try one of the presets.'
  }
  return null
}

export function describeBackupCron(cron: string): string {
  return BACKUP_SCHEDULE_PRESETS.find((preset) => preset.cron === cron.trim())?.label ?? cron
}

interface ScheduleRow {
  enabled: boolean
  s3ConnectionId: string
  prefix: string
  cron: string
  keep: number
  keyId: string
  publicKey: string
  sealedPrivateKey: unknown
  keyCreatedAt: Date
}

async function loadRow(db: Database): Promise<ScheduleRow | null> {
  const [row] = await db
    .select({
      enabled: schema.backupSchedule.enabled,
      s3ConnectionId: schema.backupSchedule.s3ConnectionId,
      prefix: schema.backupSchedule.prefix,
      cron: schema.backupSchedule.cron,
      keep: schema.backupSchedule.keep,
      keyId: schema.backupSchedule.keyId,
      publicKey: schema.backupSchedule.publicKey,
      sealedPrivateKey: schema.backupSchedule.sealedPrivateKey,
      keyCreatedAt: schema.backupSchedule.keyCreatedAt,
    })
    .from(schema.backupSchedule)
    .limit(1)
  return row ?? null
}

export async function getBackupSchedule(
  db: Database,
  now: Date = new Date(),
): Promise<BackupScheduleSummary | null> {
  const row = await loadRow(db)
  if (!row) return null
  const [connection] = await db
    .select({ name: schema.s3Connections.name, bucket: schema.s3Connections.bucket })
    .from(schema.s3Connections)
    .where(eq(schema.s3Connections.id, row.s3ConnectionId))
    .limit(1)
  return {
    enabled: row.enabled,
    s3ConnectionId: row.s3ConnectionId,
    connectionName: connection?.name ?? 'Unknown connection',
    bucket: connection?.bucket ?? '',
    prefix: row.prefix,
    cron: row.cron,
    keep: row.keep,
    keyId: row.keyId,
    keyCreatedAt: row.keyCreatedAt,
    nextRunAt: row.enabled ? nextRun(row.cron, now) : null,
  }
}

/**
 * This installation's id, made on first use. Names the folder its backups
 * go in; see the instance_identity table for why it survives a restore.
 */
export async function getInstanceId(db: Database): Promise<string> {
  await db.insert(schema.instanceIdentity).values({ id: 1 }).onConflictDoNothing()
  const [row] = await db
    .select({ instanceId: schema.instanceIdentity.instanceId })
    .from(schema.instanceIdentity)
    .limit(1)
  return row!.instanceId
}

/** The public key and its sealed private half, for writing or unlocking a backup. */
export async function getBackupKeys(
  db: Database,
): Promise<{ keyId: string; publicKey: string; sealedPrivateKey: SealedBackupKey } | null> {
  const row = await loadRow(db)
  if (!row) return null
  return {
    keyId: row.keyId,
    publicKey: row.publicKey,
    sealedPrivateKey: row.sealedPrivateKey as SealedBackupKey,
  }
}

/** Whether a passphrase opens the current key. For "check my passphrase". */
export async function checkBackupPassphrase(db: Database, passphrase: string): Promise<boolean> {
  const keys = await getBackupKeys(db)
  return keys !== null && openBackupKey(keys, passphrase) !== null
}

/**
 * Where backups go, with the connection's secret decrypted. Server-side only.
 *
 * A managed, writable location, so the adapter will write and delete — but
 * only ever under the prefix, which is checked at save time to be nobody
 * else's.
 */
export async function backupLocation(db: Database): Promise<ServiceResult<LibraryLocation>> {
  const row = await loadRow(db)
  if (!row) return { ok: false, error: 'Scheduled backups are not set up.' }
  return backupLocationFor(db, row.s3ConnectionId, row.prefix)
}

async function backupLocationFor(
  db: Database,
  connectionId: string,
  prefix: string,
): Promise<ServiceResult<LibraryLocation>> {
  const connection = await loadS3ConnectionForCheck(db, connectionId)
  if (!connection.ok) return connection
  return {
    ok: true,
    data: {
      ...s3CheckLocation(connection.data, prefix),
      id: 'backups',
      kind: 'managed',
      allowWrites: true,
    },
  }
}

/**
 * The library whose part of the bucket a backup prefix would share, if any.
 *
 * Backups get a prefix to themselves: a scan of an overlapping library would
 * list them, and a managed library's writes could land among them.
 */
async function libraryOverlapping(
  db: Database,
  connectionId: string,
  prefix: string,
): Promise<string | null> {
  const [target] = await db
    .select({ bucket: schema.s3Connections.bucket, endpoint: schema.s3Connections.endpoint })
    .from(schema.s3Connections)
    .where(eq(schema.s3Connections.id, connectionId))
    .limit(1)
  if (!target) return null

  const libraries = await db
    .select({
      name: schema.libraries.name,
      prefix: schema.libraries.s3Prefix,
      endpoint: schema.s3Connections.endpoint,
    })
    .from(schema.libraries)
    .innerJoin(schema.s3Connections, eq(schema.s3Connections.id, schema.libraries.s3ConnectionId))
    .where(eq(schema.s3Connections.bucket, target.bucket))

  const clash = libraries.find(
    (library) =>
      (library.endpoint ?? null) === (target.endpoint ?? null) &&
      s3PrefixesOverlap(library.prefix, prefix),
  )
  return clash?.name ?? null
}

export async function saveBackupSchedule(
  db: Database,
  input: BackupScheduleInput,
  check: BackupWriteCheck = checkBackupWrite,
): Promise<ServiceResult<{ newKey: boolean; keyId: string }>> {
  const prefix = normalizeS3Prefix(input.prefix)
  if (!prefix) return { ok: false, error: 'Give backups a folder of their own in the bucket.' }
  if (prefix.length > 500) return { ok: false, error: 'Keep the folder name under 500 characters.' }

  const cronIssue = backupCronProblem(input.cron)
  if (cronIssue) return { ok: false, error: cronIssue }

  const keep = Math.floor(input.keep)
  if (!Number.isFinite(keep) || keep < BACKUP_KEEP_MIN || keep > BACKUP_KEEP_MAX) {
    return {
      ok: false,
      error: `Keep between ${BACKUP_KEEP_MIN} and ${BACKUP_KEEP_MAX} backups.`,
    }
  }

  const existing = await loadRow(db)
  const passphrase = input.passphrase ?? ''
  if (!existing && !passphrase) {
    return { ok: false, error: 'Choose a passphrase to encrypt backups with.' }
  }
  if (passphrase && passphrase.length < BACKUP_PASSPHRASE_MIN_LENGTH) {
    return {
      ok: false,
      error: `Use a passphrase of at least ${BACKUP_PASSPHRASE_MIN_LENGTH} characters.`,
    }
  }

  const clash = await libraryOverlapping(db, input.s3ConnectionId, prefix)
  if (clash) {
    return {
      ok: false,
      error: `That folder overlaps the library “${clash}”. Choose a prefix no library uses.`,
    }
  }

  const location = await backupLocationFor(db, input.s3ConnectionId, prefix)
  if (!location.ok) return location
  // Checked whenever the destination changes, and when a schedule is first
  // turned on, so a read-only key is found now rather than at 02:30.
  const moved =
    !existing || existing.s3ConnectionId !== input.s3ConnectionId || existing.prefix !== prefix
  if (moved || (input.enabled && !existing?.enabled)) {
    const writable = await check(location.data)
    if (!writable.ok) return { ok: false, error: writable.reason }
  }

  const keys = passphrase ? createBackupKeyPair(passphrase) : null
  const values = {
    enabled: input.enabled,
    s3ConnectionId: input.s3ConnectionId,
    prefix,
    cron: input.cron.trim(),
    keep,
    updatedAt: new Date(),
    ...(keys
      ? {
          keyId: keys.keyId,
          publicKey: keys.publicKey,
          sealedPrivateKey: keys.sealedPrivateKey,
          keyCreatedAt: new Date(),
        }
      : {}),
  }

  if (existing) {
    await db.update(schema.backupSchedule).set(values).where(eq(schema.backupSchedule.id, 1))
  } else if (keys) {
    await db.insert(schema.backupSchedule).values({
      ...values,
      id: 1,
      keyId: keys.keyId,
      publicKey: keys.publicKey,
      sealedPrivateKey: keys.sealedPrivateKey,
    })
  }
  return { ok: true, data: { newKey: keys !== null, keyId: keys?.keyId ?? existing!.keyId } }
}

/** Stops scheduled backups and forgets the key. Backups already in the bucket stay. */
export async function removeBackupSchedule(db: Database): Promise<void> {
  await db.delete(schema.backupSchedule)
}

/**
 * Whether the schedule has come round. Measured against the last run that
 * started, failed ones included, so a broken bucket is retried at the next
 * fire time rather than on every sweep.
 */
export async function backupDue(db: Database, now: Date = new Date()): Promise<boolean> {
  const row = await loadRow(db)
  if (!row?.enabled) return false
  const [last] = await db
    .select({ at: sql<Date | null>`max(${schema.backupRuns.startedAt})` })
    .from(schema.backupRuns)
  const lastAt = last?.at ? new Date(last.at) : null
  return isScanDue(row.cron, lastAt ?? row.keyCreatedAt, now)
}

export async function listBackupRuns(db: Database, limit = 20): Promise<BackupRunSummary[]> {
  return db
    .select({
      id: schema.backupRuns.id,
      trigger: schema.backupRuns.trigger,
      status: schema.backupRuns.status,
      startedAt: schema.backupRuns.startedAt,
      finishedAt: schema.backupRuns.finishedAt,
      objectName: schema.backupRuns.objectName,
      bytes: schema.backupRuns.bytes,
      pruned: schema.backupRuns.pruned,
      keyId: schema.backupRuns.keyId,
      error: schema.backupRuns.error,
      requestedBy: schema.backupRuns.requestedBy,
    })
    .from(schema.backupRuns)
    .orderBy(desc(schema.backupRuns.startedAt))
    .limit(limit)
}
