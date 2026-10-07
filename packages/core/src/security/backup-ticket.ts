import { signToken } from './signed-token'

/**
 * Tickets for the worker's backup and restore endpoints.
 *
 * The web tier decides who may back up or restore and signs a ticket saying
 * so; the worker, which has no sessions, verifies it. The subject names who
 * asked, and the worker checks them again against the database it is about to
 * read or replace.
 */

/** A restore from the first-run screen, before any account exists. */
export const BACKUP_FIRST_RUN_SUBJECT = 'first-run'
export const backupUserSubject = (userId: string) => `user:${userId}`

/** Carries a restore ticket, URL-encoded. Lower case, as Node reports header names. */
export const BACKUP_TICKET_HEADER = 'x-printbench-backup-ticket'

/** An export is submitted the moment the ticket is issued. */
const EXPORT_TTL_MS = 5 * 60 * 1000
/** A restore covers a large upload, the restore itself and the polling after. */
const RESTORE_TTL_MS = 12 * 60 * 60 * 1000

export interface BackupTicket {
  token: string
  expires: string
  subject: string
}

export function signBackupTicket(
  secret: string,
  purpose: 'backup-export' | 'backup-restore',
  subject: string,
): BackupTicket {
  const signed = signToken(
    secret,
    purpose,
    subject,
    purpose === 'backup-export' ? EXPORT_TTL_MS : RESTORE_TTL_MS,
  )
  return { token: signed.token, expires: String(signed.expires), subject }
}
