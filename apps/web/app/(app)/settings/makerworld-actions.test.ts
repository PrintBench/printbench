import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  user: { id: 'signed-in-user', role: 'member', banned: false },
  requireUser: vi.fn(),
  assertCan: vi.fn(),
  cookieStatus: vi.fn(),
  saveCookie: vi.fn(),
  startSignIn: vi.fn(),
  verifySignIn: vi.fn(),
  cancelSignIn: vi.fn(),
  checkConnection: vi.fn(),
}))

vi.mock('@pb/auth', () => ({ requireUser: mocks.requireUser }))
vi.mock('@pb/db', () => ({ getDb: () => 'db' }))
vi.mock('@pb/core', () => ({
  PolicyError: class PolicyError extends Error {},
  MakerWorldImportError: class MakerWorldImportError extends Error {},
  assertCan: mocks.assertCan,
  getMakerWorldCookieStatus: mocks.cookieStatus,
  saveMakerWorldCookie: mocks.saveCookie,
  startMakerWorldSignIn: mocks.startSignIn,
  verifyMakerWorldSignIn: mocks.verifySignIn,
  cancelMakerWorldSignIn: mocks.cancelSignIn,
  checkMakerWorldConnection: mocks.checkConnection,
  BambuSignInError: class BambuSignInError extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message)
    }
  },
  MakerWorldChallengeError: class MakerWorldChallengeError extends Error {
    constructor(
      message: string,
      public retryChallengeId: string | null = null,
    ) {
      super(message)
    }
  },
}))

import { PolicyError, BambuSignInError, MakerWorldChallengeError } from '@pb/core'
import {
  readMakerWorldCookieStatus,
  setMakerWorldCookie,
  connectMakerWorld,
  verifyMakerWorldConnection,
  cancelMakerWorldConnection,
  testMakerWorldConnection,
} from './makerworld-actions'

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
    expect(await readMakerWorldCookieStatus()).toMatchObject({ ok: false, error: 'Not permitted.' })
    expect(await setMakerWorldCookie('secret')).toMatchObject({
      ok: false,
      error: 'Not permitted.',
    })
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

describe('direct MakerWorld connection actions', () => {
  it('authorizes every action before credentials, challenges or network calls are accessed', async () => {
    mocks.assertCan.mockImplementation(() => {
      throw new PolicyError('file:upload')
    })
    for (const operation of [
      () => connectMakerWorld({ email: 'synthetic@example.test', password: 'secret' }),
      () => verifyMakerWorldConnection({ challengeId: 'challenge', code: '123456' }),
      cancelMakerWorldConnection,
      testMakerWorldConnection,
    ]) {
      expect(await operation()).toMatchObject({ ok: false, error: 'Not permitted.' })
    }
    for (const mock of [
      mocks.startSignIn,
      mocks.verifySignIn,
      mocks.cancelSignIn,
      mocks.checkConnection,
    ])
      expect(mock).not.toHaveBeenCalled()
  })
  it('scopes login and verification to the signed-in PrintBench user and returns no tokens', async () => {
    const status = { state: 'verification', method: 'email', challengeId: 'opaque-id' }
    mocks.startSignIn.mockResolvedValue(status)
    expect(
      await connectMakerWorld({ email: 'synthetic@example.test', password: 'secret' }),
    ).toEqual({ ok: true, status })
    expect(mocks.startSignIn).toHaveBeenCalledWith(
      'db',
      mocks.user.id,
      'synthetic@example.test',
      'secret',
    )
    mocks.verifySignIn.mockResolvedValue({ state: 'connected' })
    expect(await verifyMakerWorldConnection({ challengeId: 'opaque-id', code: '123456' })).toEqual({
      ok: true,
      status: { state: 'connected' },
    })
    expect(mocks.verifySignIn).toHaveBeenCalledWith('db', mocks.user.id, 'opaque-id', '123456')
  })
  it('returns deliberately safe authentication errors and retry IDs, never arbitrary remote errors', async () => {
    mocks.startSignIn.mockRejectedValue(new Error('private-password private-token'))
    expect(
      JSON.stringify(
        await connectMakerWorld({ email: 'synthetic@example.test', password: 'secret' }),
      ),
    ).not.toContain('private')
    mocks.startSignIn.mockRejectedValue(new BambuSignInError('rejected', 'Safe refusal'))
    expect(
      await connectMakerWorld({ email: 'synthetic@example.test', password: 'secret' }),
    ).toEqual({ ok: false, error: 'Safe refusal' })
    mocks.verifySignIn.mockRejectedValue(new MakerWorldChallengeError('Wrong code', 'new-id'))
    expect(await verifyMakerWorldConnection({ challengeId: 'old-id', code: '123456' })).toEqual({
      ok: false,
      error: 'Wrong code',
      retryChallengeId: 'new-id',
    })
    mocks.verifySignIn.mockRejectedValue(new MakerWorldChallengeError('Expired'))
    expect(await verifyMakerWorldConnection({ challengeId: 'old-id', code: '123456' })).toEqual({
      ok: false,
      error: 'Expired',
      restart: true,
    })
  })
  it('cancels pending verification before a cookie replacement or disconnect', async () => {
    await setMakerWorldCookie('')
    expect(mocks.cancelSignIn).toHaveBeenCalledWith('db', mocks.user.id)
    expect(mocks.cancelSignIn.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.saveCookie.mock.invocationCallOrder[0]!,
    )
    expect(await cancelMakerWorldConnection()).toEqual({ ok: true })
    mocks.checkConnection.mockResolvedValue('expired')
    expect(await testMakerWorldConnection()).toEqual({ ok: true, state: 'expired' })
    expect(mocks.checkConnection).toHaveBeenCalledWith('db', mocks.user.id)
  })
})
