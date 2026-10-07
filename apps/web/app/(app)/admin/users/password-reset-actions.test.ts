import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PolicyError } from '@pb/core'

const mocks = vi.hoisted(() => ({ requireUser: vi.fn(), issue: vi.fn() }))
vi.mock('@pb/auth', () => ({
  requireUser: mocks.requireUser,
  issuePasswordReset: mocks.issue,
  PasswordRecoveryError: class extends Error {},
}))
vi.mock('@pb/db', () => ({ getDb: () => 'test-db' }))
// The audit trail has its own tests; here it would only write to a real database.
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => {}) }))
import { createPasswordResetLink } from './password-reset-actions'

describe('admin password reset action', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.unstubAllEnvs()
    vi.stubEnv('APP_URL', 'http://192.0.2.1:3218')
    vi.stubEnv('BETTER_AUTH_URL', '')
    mocks.requireUser.mockResolvedValue({ id: 'admin', role: 'admin', banned: false })
    mocks.issue.mockResolvedValue({
      token: 'private-reset-token',
      expiresAt: new Date('2026-10-02T12:00:00Z'),
    })
  })
  it('requires authentication', async () => {
    mocks.requireUser.mockRejectedValue(new PolicyError('user:manage'))
    expect((await createPasswordResetLink('target')).ok).toBe(false)
    expect(mocks.issue).not.toHaveBeenCalled()
  })
  it.each([
    { role: 'viewer', banned: false },
    { role: 'member', banned: false },
    { role: 'admin', banned: true },
  ])('rejects unauthorized issuer %j', async (actor) => {
    mocks.requireUser.mockResolvedValue({ id: 'actor', ...actor })
    expect((await createPasswordResetLink('target')).ok).toBe(false)
    expect(mocks.issue).not.toHaveBeenCalled()
  })
  it('uses the configured address and issues only for the selected user', async () => {
    const result = await createPasswordResetLink('target')
    expect(result).toEqual({
      ok: true,
      url: 'http://192.0.2.1:3218/reset-password?token=private-reset-token',
      expiresAt: '2026-10-02T12:00:00.000Z',
    })
    expect(mocks.issue).toHaveBeenCalledWith('test-db', 'target')
  })
  it('does not issue a token when the app address is invalid', async () => {
    vi.stubEnv('APP_URL', 'javascript:bad')
    expect((await createPasswordResetLink('target')).ok).toBe(false)
    expect(mocks.issue).not.toHaveBeenCalled()
  })
  it('hides unexpected database errors', async () => {
    mocks.issue.mockRejectedValue(new Error('database-password'))
    expect(await createPasswordResetLink('target')).toEqual({
      ok: false,
      error: 'Could not create a password reset link.',
    })
  })
})
