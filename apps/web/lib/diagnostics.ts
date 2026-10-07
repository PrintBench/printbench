import { getSessionUser } from '@pb/auth'
import { can } from '@pb/core'

/** The signed-in user if they may read diagnostics, otherwise null. */
export async function diagnosticsUser() {
  const user = await getSessionUser()
  if (!user) return null
  const allowed = can(
    { id: user.id, role: user.role ?? null, banned: user.banned ?? false },
    'diagnostics:view',
  )
  return allowed ? user : null
}

export function forbidden(): Response {
  return new Response('Not permitted', { status: 403 })
}

/** A filename-safe timestamp: 2026-10-07T14-03-09Z. */
export function fileStamp(): string {
  return new Date()
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/:/g, '-')
}
