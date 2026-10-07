import { headers } from 'next/headers'
import { recordAudit, type AuditAction, type AuditEventInput } from '@pb/core'
import { getDb } from '@pb/db'

/** Same order the auth layer trusts: the proxy's view of the client first. */
const IP_HEADERS = ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip']

export async function requestIp(): Promise<string | null> {
  try {
    const all = await headers()
    for (const name of IP_HEADERS) {
      const value = all.get(name)?.split(',')[0]?.trim()
      if (value) return value
    }
  } catch {
    // Called outside a request; there is no client to name.
  }
  return null
}

/**
 * Records something a signed-in person just did.
 *
 * Call it after the work has succeeded. It never throws, so it cannot turn a
 * change that worked into an error, and it adds the caller's IP itself.
 */
export async function audit(
  user: { id: string; name?: string | null },
  action: AuditAction,
  target?: AuditEventInput['target'],
  detail?: Record<string, unknown>,
): Promise<void> {
  await recordAudit(getDb(), {
    action,
    actor: { type: 'user', id: user.id, name: user.name ?? null },
    target,
    detail,
    ip: await requestIp(),
  })
}
