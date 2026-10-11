'use server'

import {
  PolicyError,
  assertCan,
  backupUserSubject,
  signBackupTicket,
  type BackupTicket,
} from '@pb/core'
import { requireUser } from '@pb/auth'

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
