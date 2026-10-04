import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  user: { id: 'signed-in-user', role: 'member', banned: false },
  requireUser: vi.fn(),
  assertCan: vi.fn(),
  tokenStatus: vi.fn(),
  saveToken: vi.fn(),
}))

vi.mock('@pb/auth', () => ({ requireUser: mocks.requireUser }))
vi.mock('@pb/db', () => ({ getDb: () => 'db' }))
vi.mock('@pb/core', () => ({
  PolicyError: class PolicyError extends Error {},
  MakerWorldImportError: class MakerWorldImportError extends Error {},
  assertCan: mocks.assertCan,
  getThingiverseTokenStatus: mocks.tokenStatus,
  saveThingiverseToken: mocks.saveToken,
}))

import { PolicyError } from '@pb/core'
import { readThingiverseTokenStatus, setThingiverseToken } from './thingiverse-actions'

beforeEach(() => {
  vi.resetAllMocks()
  mocks.requireUser.mockResolvedValue(mocks.user)
  mocks.tokenStatus.mockResolvedValue(true)
})

describe('personal Thingiverse connection settings', () => {
  it('authorizes both operations before accessing private data, including banned state', async () => {
    mocks.assertCan.mockImplementation(() => {
      throw new PolicyError('file:upload')
    })
    expect(await readThingiverseTokenStatus()).toEqual({ ok: false, error: 'Not permitted.' })
    expect(await setThingiverseToken('secret')).toEqual({ ok: false, error: 'Not permitted.' })
    expect(mocks.requireUser).toHaveBeenCalledTimes(2)
    expect(mocks.assertCan).toHaveBeenCalledWith(mocks.user, 'file:upload')
    expect(mocks.tokenStatus).not.toHaveBeenCalled()
    expect(mocks.saveToken).not.toHaveBeenCalled()
  })

  it('returns only saved status scoped to the signed-in account', async () => {
    expect(await readThingiverseTokenStatus()).toEqual({ ok: true, saved: true })
    expect(mocks.tokenStatus).toHaveBeenCalledWith('db', mocks.user.id)
    expect(mocks.saveToken).not.toHaveBeenCalled()
  })

  it('saves or removes the signed-in account API token without returning it', async () => {
    expect(await setThingiverseToken('secret-token')).toEqual({ ok: true, saved: true })
    expect(mocks.saveToken).toHaveBeenCalledWith('db', mocks.user.id, 'secret-token')
    mocks.tokenStatus.mockResolvedValue(false)
    expect(await setThingiverseToken('')).toEqual({ ok: true, saved: false })
    expect(mocks.saveToken).toHaveBeenLastCalledWith('db', mocks.user.id, '')
  })

  it('hides unexpected credential and session errors', async () => {
    mocks.saveToken.mockRejectedValue(new Error('secret-token'))
    const result = await setThingiverseToken('secret-token')
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('secret-token')
    mocks.requireUser.mockRejectedValue(new Error('private-session'))
    expect(await readThingiverseTokenStatus()).toEqual({
      ok: false,
      error: 'Could not check your Thingiverse connection.',
    })
  })
})
