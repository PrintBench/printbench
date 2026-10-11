'use server'

import { BACKUP_FIRST_RUN_SUBJECT, signBackupTicket, type BackupTicket } from '@pb/core'
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
