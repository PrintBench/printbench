'use server'

import {
  BACKUP_FIRST_RUN_SUBJECT,
  describeS3Error,
  listBucketBackups,
  restoreSourceLocation,
  signBackupTicket,
  type BackupTicket,
} from '@pb/core'
import { toBucketRow, type BucketRow } from '@/lib/bucket-rows'
import { needsFirstRunSetup } from '@/lib/setup'

type TicketResult = { ok: true; ticket: BackupTicket } | { ok: false; error: string }

/**
 * Signs a restore ticket for an instance that has no accounts yet.
 *
 * Open to anyone who can reach the page, exactly as creating the first admin
 * is, and closed by the same condition: once a single account exists this
 * refuses, and so does the worker when the ticket is presented.
 */
export async function createFirstRunRestoreTicket(): Promise<TicketResult> {
  if (!(await needsFirstRunSetup())) {
    return { ok: false, error: 'Setup has already been completed.' }
  }

  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret) return { ok: false, error: 'Backups are not configured on this server.' }

  return { ok: true, ticket: signBackupTicket(secret, 'backup-restore', BACKUP_FIRST_RUN_SUBJECT) }
}

type ListResult = { ok: true; rows: BucketRow[] } | { ok: false; error: string }

/**
 * Lists the backups in a bucket typed into the first-run screen.
 *
 * A new server has no S3 connection to look up, so the bucket and its
 * credentials come from the form, are used for this listing and are dropped.
 * Nothing is saved: the database restored from the bucket brings its own
 * connection back. Small reads only — the listing and each backup's header —
 * so this is fine in the web tier; fetching the backup itself is the
 * worker's.
 *
 * Takes `unknown` because a server action's arguments are whatever the
 * request carried.
 */
export async function listRestoreSourceBackups(source: unknown): Promise<ListResult> {
  if (!(await needsFirstRunSetup())) {
    return { ok: false, error: 'Setup has already been completed.' }
  }
  const location = restoreSourceLocation(source)
  if (!location.ok) return location

  try {
    return { ok: true, rows: (await listBucketBackups(location.data)).map(toBucketRow) }
  } catch (error) {
    // The reason only: the error itself may carry the request, key ID and all.
    return { ok: false, error: describeS3Error(error, location.data.s3Bucket ?? '') }
  }
}
