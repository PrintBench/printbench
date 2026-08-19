/**
 * Authorization, in one place.
 *
 * The same `can()` is called by server actions (to enforce) and by the UI (to
 * decide what to render), so the two cannot drift. Hiding a button is never
 * authorization on its own — every mutating action calls this server-side too.
 */

export const ROLES = { admin: 'admin', member: 'member', viewer: 'viewer' } as const
export type Role = (typeof ROLES)[keyof typeof ROLES]

/** Ascending privilege. Index order is the hierarchy. */
export const ROLE_ORDER: readonly Role[] = [ROLES.viewer, ROLES.member, ROLES.admin]

export function roleAtLeast(role: Role | null | undefined, minimum: Role): boolean {
  if (!role) return false
  const have = ROLE_ORDER.indexOf(role)
  const need = ROLE_ORDER.indexOf(minimum)
  return have >= 0 && need >= 0 && have >= need
}

export type Action =
  // Reading
  | 'model:view'
  | 'file:download'
  // Curation — the day-to-day work
  | 'model:create'
  | 'model:edit'
  | 'model:delete'
  | 'tag:edit'
  | 'collection:edit'
  | 'creator:edit'
  | 'file:upload'
  | 'print:log'
  // Personal, available to anyone signed in
  | 'list:manage'
  | 'like:toggle'
  // Operations
  | 'scan:trigger'
  | 'problem:resolve'
  | 'printhost:send'
  // Administration
  | 'library:manage'
  | 'printhost:manage'
  | 'user:manage'
  | 'settings:manage'

/** Minimum role for each action. Absent = admin only, by deliberate default. */
const MINIMUM: Record<Action, Role> = {
  'model:view': ROLES.viewer,
  'file:download': ROLES.viewer,
  'list:manage': ROLES.viewer,
  'like:toggle': ROLES.viewer,

  'model:create': ROLES.member,
  'model:edit': ROLES.member,
  'model:delete': ROLES.member,
  'tag:edit': ROLES.member,
  'collection:edit': ROLES.member,
  'creator:edit': ROLES.member,
  'file:upload': ROLES.member,
  'print:log': ROLES.member,
  'scan:trigger': ROLES.member,
  'problem:resolve': ROLES.member,
  'printhost:send': ROLES.member,

  'library:manage': ROLES.admin,
  'printhost:manage': ROLES.admin,
  'user:manage': ROLES.admin,
  'settings:manage': ROLES.admin,
}

export interface PolicyUser {
  id: string
  role?: Role | string | null
  banned?: boolean | null
}

/** Ownership-scoped resources: a viewer may edit their own list, not others'. */
export interface OwnedResource {
  userId?: string | null
}

export function can(
  user: PolicyUser | null | undefined,
  action: Action,
  resource?: OwnedResource,
): boolean {
  if (!user) return false
  // A banned user keeps a valid session until it expires; deny immediately.
  if (user.banned) return false

  const role = normalizeRole(user.role)
  if (!role) return false

  // Personal collections belong to their owner regardless of role.
  if ((action === 'list:manage' || action === 'like:toggle') && resource) {
    if (resource.userId && resource.userId !== user.id) {
      // Only an admin may touch someone else's list.
      return role === ROLES.admin
    }
  }

  return roleAtLeast(role, MINIMUM[action])
}

/** Throwing variant for server actions. */
export function assertCan(
  user: PolicyUser | null | undefined,
  action: Action,
  resource?: OwnedResource,
): void {
  if (!can(user, action, resource)) {
    throw new PolicyError(action)
  }
}

export class PolicyError extends Error {
  readonly action: Action
  constructor(action: Action) {
    super(`Not permitted: ${action}`)
    this.name = 'PolicyError'
    this.action = action
  }
}

function normalizeRole(value: unknown): Role | null {
  return typeof value === 'string' && ROLE_ORDER.includes(value as Role) ? (value as Role) : null
}

export { MINIMUM as ACTION_MINIMUM_ROLE }
