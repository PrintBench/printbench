/**
 * Three roles, deliberately few. ManyFold has five plus per-object ACLs; for a
 * handful of people sharing one instance that is more machinery than value.
 */
export const ROLES = {
  admin: 'admin',
  member: 'member',
  viewer: 'viewer',
} as const

export type Role = (typeof ROLES)[keyof typeof ROLES]

export const ROLE_ORDER: Role[] = [ROLES.viewer, ROLES.member, ROLES.admin]

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
}

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: 'Full control, including libraries, users and settings.',
  member: 'Can add and edit models, tags, collections and print history.',
  viewer: 'Can browse and download. Can keep their own lists and likes.',
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && value in ROLES
}

/** Roles are hierarchical: admin satisfies member, member satisfies viewer. */
export function roleAtLeast(role: Role | null | undefined, minimum: Role): boolean {
  if (!role) return false
  return ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(minimum)
}
