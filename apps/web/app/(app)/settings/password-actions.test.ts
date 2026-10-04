import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  changePassword: vi.fn(),
  headers: vi.fn(),
}))
vi.mock('@pb/auth', () => ({
  requireUser: mocks.requireUser,
  getAuth: () => ({ api: { changePassword: mocks.changePassword } }),
}))
vi.mock('next/headers', () => ({ headers: mocks.headers }))
import { changeOwnPassword } from './password-actions'

describe('own password action', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.requireUser.mockResolvedValue({ id: 'owner', role: 'viewer', banned: false })
    mocks.headers.mockResolvedValue(new Headers({ cookie: 'test-session' }))
  })
  it('requires authentication', async () => {
    mocks.requireUser.mockRejectedValue(new Error('unauthenticated'))
    expect(
      (await changeOwnPassword({ currentPassword: 'old-password', newPassword: 'new-password' }))
        .ok,
    ).toBe(false)
    expect(mocks.changePassword).not.toHaveBeenCalled()
  })
  it('rejects suspended accounts', async () => {
    mocks.requireUser.mockResolvedValue({ banned: true })
    expect(
      (await changeOwnPassword({ currentPassword: 'old-password', newPassword: 'new-password' }))
        .ok,
    ).toBe(false)
    expect(mocks.changePassword).not.toHaveBeenCalled()
  })
  it.each(['short', 'x'.repeat(201)])('rejects invalid password length', async (newPassword) => {
    expect((await changeOwnPassword({ currentPassword: 'old-password', newPassword })).ok).toBe(
      false,
    )
    expect(mocks.changePassword).not.toHaveBeenCalled()
  })
  it('lets viewers change their own password with current-password verification and revokes other sessions', async () => {
    expect(
      await changeOwnPassword({ currentPassword: 'old-password', newPassword: 'new-password' }),
    ).toEqual({ ok: true })
    expect(mocks.changePassword).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      body: {
        currentPassword: 'old-password',
        newPassword: 'new-password',
        revokeOtherSessions: true,
      },
    })
  })
  it('does not expose upstream errors or credentials', async () => {
    mocks.changePassword.mockRejectedValue(new Error('private-current-password'))
    const result = await changeOwnPassword({
      currentPassword: 'private-current-password',
      newPassword: 'new-password',
    })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('private-current-password')
  })
})
