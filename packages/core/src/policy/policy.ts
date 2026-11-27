/**
 * Authorization, in one place.
 *
 * The same `can()` is called by server actions (to enforce) and by the UI (to
 * decide what to render), so the two cannot drift. Hiding a button is never
 * authorization on its own — every mutating action calls this server-side too.
 */

import { isDemoMode } from '../config/demo'

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
  | 'filament:view'
  | 'filament:manage'
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
  | 'note:create'
  | 'note:manage'
  | 'photo:create'
  | 'photo:manage'
  | 'request:manage'
  // Personal, available to anyone signed in
  | 'list:manage'
  | 'like:toggle'
  | 'request:create'
  // Operations
  | 'scan:trigger'
  | 'problem:resolve'
  | 'printhost:send'
  // Administration
  | 'library:manage'
  | 'printhost:manage'
  | 'user:manage'
  | 'settings:manage'
  | 'diagnostics:view'
  | 'instance:backup'

/** Minimum role for each action. Absent = admin only, by deliberate default. */
const MINIMUM: Record<Action, Role> = {
  'filament:view': ROLES.viewer,
  'filament:manage': ROLES.member,
  'model:view': ROLES.viewer,
  'file:download': ROLES.viewer,
  'list:manage': ROLES.viewer,
  'like:toggle': ROLES.viewer,
  /*
   * Anyone signed in may ask for something to be printed — that is the whole
   * point of the queue, and the person asking is usually the one with the
   * least access. Working through it is 'request:manage' and needs a member.
   */
  'request:create': ROLES.viewer,

  'model:create': ROLES.member,
  'model:edit': ROLES.member,
  'model:delete': ROLES.member,
  'tag:edit': ROLES.member,
  'collection:edit': ROLES.member,
  'creator:edit': ROLES.member,
  'file:upload': ROLES.member,
  'print:log': ROLES.member,
  /*
   * Writing a note about a shared model is curation, like logging a print, so
   * it needs a member. Editing one is further scoped to its author below: a
   * member may correct their own note, and only an admin may touch someone
   * else's.
   */
  'note:create': ROLES.member,
  'note:manage': ROLES.member,
  // Photographs are authored the same way, and scoped the same way.
  'photo:create': ROLES.member,
  'photo:manage': ROLES.member,
  'request:manage': ROLES.member,
  'scan:trigger': ROLES.member,
  'problem:resolve': ROLES.member,
  'printhost:send': ROLES.member,

  'library:manage': ROLES.admin,
  'printhost:manage': ROLES.admin,
  'user:manage': ROLES.admin,
  'settings:manage': ROLES.admin,
  // Audit trail, logs and the debug report expose who did what and how the
  // instance is run, so they are for whoever runs it.
  'diagnostics:view': ROLES.admin,
  // A backup holds every account and credential, and a restore replaces the
  // whole instance.
  'instance:backup': ROLES.admin,
}

export interface PolicyUser {
  id: string
  role?: Role | string | null
  banned?: boolean | null
  /**
   * Set by the server when rendering for a demo instance. The browser cannot
   * read PRINTBENCH_DEMO, so the sidebar's copy of can() learns it here.
   */
  demo?: boolean
}

/**
 * Areas a public demo visitor must not reach, whatever their role.
 *
 * Users and invitations would let one visitor lock out the next; backups hold
 * every credential; diagnostics show how the host is run; print hosts make the
 * server connect to any address a stranger types. The rest of the admin UI
 * stays open, because showing it is the point of a demo.
 */
const DEMO_DENIED: ReadonlySet<Action> = new Set([
  'user:manage',
  'instance:backup',
  'diagnostics:view',
  'printhost:manage',
  'printhost:send',
])

/** Ownership-scoped resources: a viewer may edit their own list, not others'. */
export interface OwnedResource {
  userId?: string | null
}

/**
 * Actions where the row's owner matters as much as the role. Anyone below
 * admin may act on their own row and no one else's.
 */
const OWNED: ReadonlySet<Action> = new Set([
  'list:manage',
  'like:toggle',
  'note:manage',
  'photo:manage',
])

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

  if (DEMO_DENIED.has(action) && (user.demo || isDemoMode())) return false

  // Personal collections and authored notes belong to whoever made them,
  // regardless of role.
  if (OWNED.has(action) && resource) {
    if (resource.userId && resource.userId !== user.id) {
      // Only an admin may touch someone else's.
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

/**
 * Triggering a normal scan is an operational task available to members.
 * Scan options that can rewrite library metadata require library management.
 */
export function assertCanTriggerScan(
  user: PolicyUser | null | undefined,
  options: { force?: boolean; restoreSidecars?: boolean } = {},
): void {
  assertCan(user, options.force || options.restoreSidecars ? 'library:manage' : 'scan:trigger')
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
