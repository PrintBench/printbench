'use server'

import { resetPassword, PasswordRecoveryError } from '@pb/auth'
import { recordAudit } from '@pb/core'
import { getDb } from '@pb/db'
import { requestIp } from '@/lib/audit'

export async function completePasswordReset(input: {
  token: string
  password: string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const account = await resetPassword(getDb(), input)
    await recordAudit(getDb(), {
      action: 'auth.password_reset',
      actor: { type: 'user', id: account.userId, name: account.name },
      ip: await requestIp(),
    })
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof PasswordRecoveryError
          ? error.message
          : 'Could not reset your password. Please try again.',
    }
  }
}
