import { headers } from 'next/headers'
import { getAuth, type AuthUser } from './auth'
import { ROLES, roleAtLeast, type Role } from './roles'

/** Current user, or null. Never throws — for optional-auth pages. */
export async function getSessionUser(): Promise<AuthUser | null> {
  const session = await getAuth().api.getSession({ headers: await headers() })
  return (session?.user as AuthUser | undefined) ?? null
}

export class UnauthenticatedError extends Error {
  constructor() {
    super('Authentication required')
    this.name = 'UnauthenticatedError'
  }
}

export class ForbiddenError extends Error {
  constructor(required: Role) {
    super(`Requires the ${required} role`)
    this.name = 'ForbiddenError'
  }
}

/** Current user, or throws. For pages and actions that require a login. */
export async function requireUser(): Promise<AuthUser> {
  const user = await getSessionUser()
  if (!user) throw new UnauthenticatedError()
  return user
}

/**
 * Enforces a minimum role. Call at the top of every server action and route
 * handler that mutates: hiding a button in the UI is not authorization.
 */
export async function requireRole(minimum: Role): Promise<AuthUser> {
  const user = await requireUser()
  if (!roleAtLeast(user.role ?? null, minimum)) throw new ForbiddenError(minimum)
  return user
}

export const requireAdmin = () => requireRole(ROLES.admin)
export const requireMember = () => requireRole(ROLES.member)
