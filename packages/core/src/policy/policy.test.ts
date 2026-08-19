import { describe, expect, it } from 'vitest'
import { ACTION_MINIMUM_ROLE, PolicyError, ROLES, assertCan, can, roleAtLeast } from './policy'
import type { Action, PolicyUser } from './policy'

const admin: PolicyUser = { id: 'u-admin', role: ROLES.admin }
const member: PolicyUser = { id: 'u-member', role: ROLES.member }
const viewer: PolicyUser = { id: 'u-viewer', role: ROLES.viewer }

describe('roleAtLeast', () => {
  it('is hierarchical', () => {
    expect(roleAtLeast(ROLES.admin, ROLES.viewer)).toBe(true)
    expect(roleAtLeast(ROLES.member, ROLES.viewer)).toBe(true)
    expect(roleAtLeast(ROLES.viewer, ROLES.member)).toBe(false)
    expect(roleAtLeast(ROLES.member, ROLES.admin)).toBe(false)
  })

  it('treats missing or unknown roles as no access', () => {
    expect(roleAtLeast(null, ROLES.viewer)).toBe(false)
    expect(roleAtLeast(undefined, ROLES.viewer)).toBe(false)
    // A role string that is not one of ours must never grant anything.
    expect(roleAtLeast('superuser' as never, ROLES.viewer)).toBe(false)
  })
})

describe('can', () => {
  it('denies anonymous users everything', () => {
    for (const action of Object.keys(ACTION_MINIMUM_ROLE) as Action[]) {
      expect(can(null, action)).toBe(false)
      expect(can(undefined, action)).toBe(false)
    }
  })

  it('denies a banned user everything, even an admin', () => {
    const banned: PolicyUser = { id: 'u', role: ROLES.admin, banned: true }
    for (const action of Object.keys(ACTION_MINIMUM_ROLE) as Action[]) {
      expect(can(banned, action)).toBe(false)
    }
  })

  it('denies unknown roles everything', () => {
    const odd: PolicyUser = { id: 'u', role: 'root' }
    expect(can(odd, 'model:view')).toBe(false)
  })

  it('lets viewers read but not curate', () => {
    expect(can(viewer, 'model:view')).toBe(true)
    expect(can(viewer, 'file:download')).toBe(true)
    expect(can(viewer, 'model:edit')).toBe(false)
    expect(can(viewer, 'file:upload')).toBe(false)
    expect(can(viewer, 'print:log')).toBe(false)
  })

  it('lets members curate but not administer', () => {
    expect(can(member, 'model:edit')).toBe(true)
    expect(can(member, 'file:upload')).toBe(true)
    expect(can(member, 'scan:trigger')).toBe(true)
    expect(can(member, 'library:manage')).toBe(false)
    expect(can(member, 'user:manage')).toBe(false)
    expect(can(member, 'settings:manage')).toBe(false)
  })

  it('lets admins do everything', () => {
    for (const action of Object.keys(ACTION_MINIMUM_ROLE) as Action[]) {
      expect(can(admin, action)).toBe(true)
    }
  })

  describe('ownership', () => {
    it('lets a viewer manage their own list', () => {
      expect(can(viewer, 'list:manage', { userId: viewer.id })).toBe(true)
      expect(can(viewer, 'like:toggle', { userId: viewer.id })).toBe(true)
    })

    it("stops a viewer touching someone else's list", () => {
      expect(can(viewer, 'list:manage', { userId: 'someone-else' })).toBe(false)
      expect(can(member, 'list:manage', { userId: 'someone-else' })).toBe(false)
    })

    it("lets an admin manage anyone's list", () => {
      expect(can(admin, 'list:manage', { userId: 'someone-else' })).toBe(true)
    })
  })
})

describe('assertCan', () => {
  it('throws a PolicyError naming the action', () => {
    expect(() => assertCan(viewer, 'library:manage')).toThrow(PolicyError)
    try {
      assertCan(viewer, 'library:manage')
    } catch (error) {
      expect((error as PolicyError).action).toBe('library:manage')
    }
  })

  it('is silent when permitted', () => {
    expect(() => assertCan(admin, 'library:manage')).not.toThrow()
  })
})
