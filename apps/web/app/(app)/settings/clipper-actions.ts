'use server'

import { requireUser } from '@pb/auth'
import { DEMO_UNAVAILABLE, isDemoMode } from '@pb/core'
import { can } from '@pb/core/policy'
import { getDb } from '@pb/db'
import { z } from 'zod'
import { createClipperToken, revokeClipperToken } from '@/lib/clipper-tokens'

const labelSchema = z.string().trim().min(1).max(80)

export async function generateBrowserClipperToken(label: string) {
  // A bearer token outlives the visitor who made it, and its imports fetch from the internet.
  if (isDemoMode()) return { error: DEMO_UNAVAILABLE }
  try {
    const user = await requireUser()
    if (!can(user, 'file:upload')) return { error: 'Upload access is required.' }
    const parsed = labelSchema.safeParse(label)
    if (!parsed.success) return { error: 'Enter a browser name of up to 80 characters.' }
    return await createClipperToken(getDb(), user.id, parsed.data)
  } catch {
    return { error: 'Could not generate the connection token. Try again.' }
  }
}

export async function revokeBrowserClipperToken(id: string) {
  try {
    const user = await requireUser()
    if (!z.uuid().safeParse(id).success || !(await revokeClipperToken(getDb(), user.id, id))) {
      return { error: 'That connection token was not found.' }
    }
    return { ok: true }
  } catch {
    return { error: 'Could not revoke the connection token. Try again.' }
  }
}
