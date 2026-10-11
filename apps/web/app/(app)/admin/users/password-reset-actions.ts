'use server'

import { requireUser, issuePasswordReset, PasswordRecoveryError } from '@pb/auth'
import { assertCan, PolicyError } from '@pb/core'
import { getDb } from '@pb/db'
import { audit } from '@/lib/audit'

export async function createPasswordResetLink(
  userId: string,
): Promise<{ ok: true; url: string; expiresAt: string } | { ok: false; error: string }> {
  try {
    const actor = await requireUser()
    assertCan({ id: actor.id, role: actor.role ?? null, banned: actor.banned }, 'user:manage')
    const baseURL = process.env.BETTER_AUTH_URL?.trim() || process.env.APP_URL?.trim()
    if (!baseURL) return { ok: false, error: 'Configure APP_URL before creating reset links.' }
    const url = new URL('/reset-password', baseURL)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return { ok: false, error: 'Configure a valid APP_URL before creating reset links.' }
    }
    const reset = await issuePasswordReset(getDb(), userId)
    url.searchParams.set('token', reset.token)
    await audit(actor, 'auth.password_reset_issued', {
      type: 'user',
      id: userId,
      label: reset.userName,
    })
    return { ok: true, url: url.toString(), expiresAt: reset.expiresAt.toISOString() }
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof PolicyError
          ? 'Not permitted.'
          : error instanceof PasswordRecoveryError
            ? error.message
            : 'Could not create a password reset link.',
    }
  }
}
