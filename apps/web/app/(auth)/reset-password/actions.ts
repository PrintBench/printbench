'use server'

import { resetPassword, PasswordRecoveryError } from '@pb/auth'
import { getDb } from '@pb/db'

export async function completePasswordReset(input: {
  token: string
  password: string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await resetPassword(getDb(), input)
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
