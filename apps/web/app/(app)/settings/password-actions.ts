'use server'

import { headers } from 'next/headers'
import { getAuth, requireUser } from '@pb/auth'
import { audit } from '@/lib/audit'

export async function changeOwnPassword(input: {
  currentPassword: string
  newPassword: string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const user = await requireUser()
    if (user.banned) return { ok: false, error: 'Not permitted.' }
    if (input.newPassword.length < 10 || input.newPassword.length > 200) {
      return { ok: false, error: 'Use a password between 10 and 200 characters.' }
    }
    await getAuth().api.changePassword({
      headers: await headers(),
      body: { ...input, revokeOtherSessions: true },
    })
    await audit(user, 'auth.password_changed')
    return { ok: true }
  } catch {
    return {
      ok: false,
      error: 'Could not change your password. Check your current password and try again.',
    }
  }
}
