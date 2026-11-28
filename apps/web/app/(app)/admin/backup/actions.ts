'use server'

import { revalidatePath } from 'next/cache'
import {
  EnvelopeError,
  PolicyError,
  assertCan,
  backupUserSubject,
  checkBackupPassphrase,
  getBackupSchedule,
  removeBackupSchedule,
  saveBackupSchedule,
  signBackupTicket,
  type BackupScheduleInput,
  type BackupTicket,
} from '@pb/core'
import { requireUser } from '@pb/auth'
import { getDb } from '@pb/db'
import { JOB, getStartedQueue } from '@pb/jobs'
import { audit } from '@/lib/audit'

export type TicketResult = { ok: true; ticket: BackupTicket } | { ok: false; error: string }

/**
 * Signs a ticket for the worker, which builds and restores backups.
 *
 * The worker has no session, so who may do this is decided here and handed
 * over as a short-lived signature naming the admin. The worker checks that
 * admin again itself before it reads or replaces anything.
 */
async function ticketFor(purpose: 'backup-export' | 'backup-restore'): Promise<TicketResult> {
  try {
    const user = await requireUser()
    assertCan(
      { id: user.id, role: user.role ?? null, banned: user.banned ?? false },
      'instance:backup',
    )

    const secret = process.env.BETTER_AUTH_SECRET
    if (!secret) return { ok: false, error: 'Backups are not configured on this server.' }

    return { ok: true, ticket: signBackupTicket(secret, purpose, backupUserSubject(user.id)) }
  } catch (error) {
    if (error instanceof PolicyError) return { ok: false, error: 'Not permitted.' }
    return { ok: false, error: 'Could not start. Sign in again and retry.' }
  }
}

export async function createExportTicket(): Promise<TicketResult> {
  return ticketFor('backup-export')
}

export async function createRestoreTicket(): Promise<TicketResult> {
  return ticketFor('backup-restore')
}

type Result = { ok: true; message?: string } | { ok: false; error: string }

/** Only admins, and never on a demo: the same rule as downloading a backup. */
async function requireBackupAdmin() {
  const user = await requireUser()
  assertCan(
    { id: user.id, role: user.role ?? null, banned: user.banned ?? false },
    'instance:backup',
  )
  return user
}

function failure(error: unknown, fallback: string): { ok: false; error: string } {
  if (error instanceof PolicyError) return { ok: false, error: 'Not permitted.' }
  if (error instanceof EnvelopeError) return { ok: false, error: error.message }
  console.error('[backup]', fallback, error)
  return { ok: false, error: fallback }
}

export async function saveBackupScheduleAction(input: BackupScheduleInput): Promise<Result> {
  try {
    const user = await requireBackupAdmin()
    const saved = await saveBackupSchedule(getDb(), input)
    if (!saved.ok) return saved

    await audit(
      user,
      'backup.schedule_saved',
      { type: 'backup_schedule', id: 'instance', label: 'Scheduled backups' },
      // Never the passphrase; only whether a new key came of it.
      {
        enabled: input.enabled,
        schedule: input.cron,
        keep: input.keep,
        newKey: saved.data.newKey,
        key: saved.data.keyId,
      },
    )
    revalidatePath('/admin/backup')
    return {
      ok: true,
      message: saved.data.newKey
        ? 'Saved. Backups from now on are encrypted with the new passphrase.'
        : 'Saved.',
    }
  } catch (error) {
    return failure(error, 'Could not save the backup schedule.')
  }
}

export async function removeBackupScheduleAction(): Promise<Result> {
  try {
    const user = await requireBackupAdmin()
    await removeBackupSchedule(getDb())
    await audit(user, 'backup.schedule_removed', {
      type: 'backup_schedule',
      id: 'instance',
      label: 'Scheduled backups',
    })
    revalidatePath('/admin/backup')
    return { ok: true }
  } catch (error) {
    return failure(error, 'Could not turn off scheduled backups.')
  }
}

export async function backUpNowAction(): Promise<Result> {
  try {
    const user = await requireBackupAdmin()
    if (!(await getBackupSchedule(getDb()))) {
      return { ok: false, error: 'Set up scheduled backups first.' }
    }
    // getStartedQueue: the web process only sends, it never boots the queue.
    const queue = await getStartedQueue()
    await queue.send(
      JOB.backupRun,
      { trigger: 'manual', requestedBy: { id: user.id, name: user.name ?? 'An admin' } },
      { singletonKey: 'backup' },
    )
    revalidatePath('/admin/backup')
    return { ok: true, message: 'Backup queued. It appears below when it has finished.' }
  } catch (error) {
    return failure(error, 'Could not start a backup.')
  }
}

/** Lets an admin confirm they still have the passphrase, long before they need it. */
export async function checkBackupPassphraseAction(passphrase: string): Promise<Result> {
  try {
    await requireBackupAdmin()
    const matches = await checkBackupPassphrase(getDb(), passphrase)
    return matches
      ? { ok: true, message: 'That passphrase opens the current backups.' }
      : { ok: false, error: 'That is not the passphrase for the current backup key.' }
  } catch (error) {
    return failure(error, 'Could not check the passphrase.')
  }
}
