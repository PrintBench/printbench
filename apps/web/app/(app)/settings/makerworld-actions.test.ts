import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  user: { id: 'signed-in-user', role: 'member', banned: false },
  requireUser: vi.fn(),
  assertCan: vi.fn(),
  cookieStatus: vi.fn(),
  saveCookie: vi.fn(),
}))

vi.mock('@pb/auth', () => ({ requireUser: mocks.requireUser }))
vi.mock('@pb/db', () => ({ getDb: () => 'db' }))
vi.mock('@pb/core', () => ({
  PolicyError: class PolicyError extends Error {},
  MakerWorldImportError: class MakerWorldImportError extends Error {},
  assertCan: mocks.assertCan,
  getMakerWorldCookieStatus: mocks.cookieStatus,
  saveMakerWorldCookie: mocks.saveCookie,
}))

import { PolicyError } from '@pb/core'
import { readMakerWorldCookieStatus, setMakerWorldCookie } from './makerworld-actions'

beforeEach(() => {
  vi.resetAllMocks()
  mocks.requireUser.mockResolvedValue(mocks.user)
  mocks.cookieStatus.mockResolvedValue(true)
})

describe('personal MakerWorld connection settings', () => {
  it('authorizes both operations before accessing private data, including banned state', async () => {
    mocks.assertCan.mockImplementation(() => {
      throw new PolicyError('file:upload')
    })
    expect(await readMakerWorldCookieStatus()).toEqual({ ok: false, error: 'Not permitted.' })
    expect(await setMakerWorldCookie('secret')).toEqual({ ok: false, error: 'Not permitted.' })
    expect(mocks.requireUser).toHaveBeenCalledTimes(2)
    expect(mocks.assertCan).toHaveBeenCalledWith(mocks.user, 'file:upload')
    expect(mocks.cookieStatus).not.toHaveBeenCalled()
    expect(mocks.saveCookie).not.toHaveBeenCalled()
  })

  it('returns only saved status scoped to the signed-in account', async () => {
    expect(await readMakerWorldCookieStatus()).toEqual({ ok: true, saved: true })
    expect(mocks.cookieStatus).toHaveBeenCalledWith('db', mocks.user.id)
    expect(mocks.saveCookie).not.toHaveBeenCalled()
  })

  it('saves or removes the signed-in account cookie without returning it', async () => {
    expect(await setMakerWorldCookie('secret-cookie')).toEqual({ ok: true, saved: true })
    expect(mocks.saveCookie).toHaveBeenCalledWith('db', mocks.user.id, 'secret-cookie')
    mocks.cookieStatus.mockResolvedValue(false)
    expect(await setMakerWorldCookie('')).toEqual({ ok: true, saved: false })
    expect(mocks.saveCookie).toHaveBeenLastCalledWith('db', mocks.user.id, '')
  })

  it('hides unexpected credential and session errors', async () => {
    mocks.saveCookie.mockRejectedValue(new Error('secret-cookie'))
    const result = await setMakerWorldCookie('secret-cookie')
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('secret-cookie')
    mocks.requireUser.mockRejectedValue(new Error('private-session'))
    expect(await readMakerWorldCookieStatus()).toEqual({
      ok: false,
      error: 'Could not check your MakerWorld connection.',
    })
  })
})
