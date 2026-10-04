import { describe, expect, it, vi } from 'vitest'
import {
  beginBambuSignIn,
  finishBambuSignIn,
  checkBambuToken,
  type BambuAuthRequest,
} from './makerworld-auth'
import type { MakerWorldResponse } from './makerworld-network'

const response = (data: unknown, status = 200, setCookies?: string[]): MakerWorldResponse => ({
  status,
  body: Buffer.from(JSON.stringify(data)),
  setCookies,
})
const request = () => vi.fn<BambuAuthRequest>()

describe('direct Bambu authentication', () => {
  it('uses the fixed global login endpoint, an honest identity, and preserves the exact password', async () => {
    const send = request().mockResolvedValue(response({ accessToken: 'own.token' }))
    expect(await beginBambuSignIn(' person@example.test ', ' pass word ', send)).toEqual({
      state: 'authenticated',
      token: 'own.token',
    })
    const [url, options] = send.mock.calls[0]!
    expect(url).toBe('https://api.bambulab.com/v1/user-service/user/login')
    expect(JSON.parse(options.body!)).toEqual({
      account: 'person@example.test',
      password: ' pass word ',
    })
    expect(options.headers?.['User-Agent']).toContain('PrintBench')
    expect(options.headers?.['User-Agent']).not.toContain('Studio')
    expect(options).toMatchObject({ method: 'POST', maxBytes: 65536, timeoutMs: 15000 })
  })
  it('rejects malformed credentials before making a request', async () => {
    const send = request()
    await expect(beginBambuSignIn('invalid', 'secret', send)).rejects.toThrow('email and password')
    await expect(beginBambuSignIn('person@example.test', '', send)).rejects.toThrow()
    await expect(beginBambuSignIn('person@example.test', 'x'.repeat(1025), send)).rejects.toThrow()
    expect(send).not.toHaveBeenCalled()
  })
  it('recognizes email verification without trusting a prematurely returned token', async () => {
    const send = request().mockResolvedValue(
      response({ loginType: 'verifyCode', accessToken: 'premature' }),
    )
    expect(await beginBambuSignIn('person@example.test', 'secret', send)).toEqual({
      state: 'verification',
      verification: { method: 'email', email: 'person@example.test' },
    })
  })
  it('recognizes authenticator challenges and rejects missing or oversized challenge keys', async () => {
    const send = request().mockResolvedValue(response({ loginType: 'tfa', tfaKey: 'challenge' }))
    expect(await beginBambuSignIn('person@example.test', 'secret', send)).toEqual({
      state: 'verification',
      verification: { method: 'authenticator', tfaKey: 'challenge' },
    })
    for (const tfaKey of [undefined, 'x'.repeat(1025)]) {
      send.mockResolvedValue(response({ loginType: 'tfa', tfaKey }))
      await expect(beginBambuSignIn('person@example.test', 'secret', send)).rejects.toThrow(
        'usable verification challenge',
      )
    }
  })
  it('completes email verification without reusing the password', async () => {
    const send = request().mockResolvedValue(response({ accessToken: 'own.token' }))
    expect(
      await finishBambuSignIn({ method: 'email', email: 'person@example.test' }, '123456', send),
    ).toBe('own.token')
    expect(JSON.parse(send.mock.calls[0]![1].body!)).toEqual({
      account: 'person@example.test',
      code: '123456',
    })
  })
  it('completes authenticator verification with a fresh CSRF cookie and matching header', async () => {
    const send = request()
      .mockResolvedValueOnce(
        response({}, 200, [
          'unrelated=discard; Path=/',
          'bbl_csrf_token=csrf.value; Path=/; Secure',
        ]),
      )
      .mockResolvedValueOnce(response({ token: 'own.token' }))
    expect(
      await finishBambuSignIn(
        { method: 'authenticator', tfaKey: 'private.challenge' },
        '123456',
        send,
      ),
    ).toBe('own.token')
    expect(send.mock.calls[0]![0]).toBe('https://bambulab.com/api/csrf')
    expect(send.mock.calls[1]![0]).toBe('https://bambulab.com/api/sign-in/tfa')
    expect(JSON.parse(send.mock.calls[1]![1].body!)).toEqual({
      tfaKey: 'private.challenge',
      tfaCode: '123456',
    })
    expect(send.mock.calls[1]![1].headers).toMatchObject({
      Cookie: 'bbl_csrf_token=csrf.value',
      'x-bbl-csrf-token': 'csrf.value',
    })
    expect(send.mock.calls[1]![1].headers?.Authorization).toBeUndefined()
  })
  it('accepts the live CSRF response shape: 204, no body, and a cookie', async () => {
    const send = request()
      .mockResolvedValueOnce({
        status: 204,
        body: Buffer.alloc(0),
        setCookies: ['bbl_csrf_token=csrf.value; Secure'],
      })
      .mockResolvedValueOnce(response({ token: 'own.token' }))
    expect(
      await finishBambuSignIn({ method: 'authenticator', tfaKey: 'challenge' }, '123456', send),
    ).toBe('own.token')
    expect(send.mock.calls[1]![1].headers?.['x-bbl-csrf-token']).toBe('csrf.value')
  })
  it('accepts exactly the token cookie when the web verification endpoint returns an empty body', async () => {
    const send = request()
      .mockResolvedValueOnce(response({}, 200, ['bbl_csrf_token=csrf']))
      .mockResolvedValueOnce({
        status: 200,
        body: Buffer.alloc(0),
        setCookies: ['refresh_token=discard', 'token=own.token; HttpOnly'],
      })
    expect(
      await finishBambuSignIn({ method: 'authenticator', tfaKey: 'challenge' }, '123456', send),
    ).toBe('own.token')
  })
  it('does not submit authenticator credentials without a safe CSRF value', async () => {
    for (const value of [
      undefined,
      'bbl_csrf_token=bad\r\nsecret',
      'bbl_csrf_token=' + 'x'.repeat(1025),
    ]) {
      const send = request().mockResolvedValue(response({}, 200, value ? [value] : []))
      await expect(
        finishBambuSignIn({ method: 'authenticator', tfaKey: 'challenge' }, '123456', send),
      ).rejects.toThrow('security token')
      expect(send).toHaveBeenCalledTimes(1)
    }
  })
  it('rejects malformed codes before making any request', async () => {
    const send = request()
    for (const code of ['12345', '1234567', '12 456', 'secret'])
      await expect(
        finishBambuSignIn({ method: 'email', email: 'person@example.test' }, code, send),
      ).rejects.toThrow('six-digit')
    expect(send).not.toHaveBeenCalled()
  })
  it('never accepts a token from a failed login or incomplete verification', async () => {
    const send = request().mockResolvedValue(response({ accessToken: 'premature' }, 401))
    await expect(beginBambuSignIn('person@example.test', 'secret', send)).rejects.toThrow(
      'did not accept',
    )
    send.mockResolvedValue(response({ accessToken: 'premature', loginType: 'verifyCode' }))
    await expect(
      finishBambuSignIn({ method: 'email', email: 'person@example.test' }, '123456', send),
    ).rejects.toThrow('did not accept that code')
  })
  it.each([403, 418, 429])(
    'handles a blocked HTTP %s response without echoing secrets',
    async (status) => {
      const send = request().mockResolvedValue(response({ error: 'private.secret' }, status))
      await expect(beginBambuSignIn('person@example.test', 'secret', send)).rejects.toThrow(
        'blocking or limiting',
      )
      await expect(beginBambuSignIn('person@example.test', 'secret', send)).rejects.not.toThrow(
        'private.secret',
      )
    },
  )
  it('handles HTML challenges, redirects, outages and unknown login methods safely', async () => {
    const send = request().mockResolvedValue({
      status: 200,
      body: Buffer.from('<html>Just a moment...</html>'),
    })
    await expect(beginBambuSignIn('person@example.test', 'secret', send)).rejects.toThrow(
      'blocking',
    )
    send.mockResolvedValue(response({}, 302))
    await expect(beginBambuSignIn('person@example.test', 'secret', send)).rejects.toThrow(
      'redirected',
    )
    send.mockResolvedValue(response({}, 503))
    await expect(beginBambuSignIn('person@example.test', 'secret', send)).rejects.toThrow(
      'temporarily unavailable',
    )
    send.mockResolvedValue(response({ loginType: 'new-method', accessToken: 'premature' }))
    await expect(beginBambuSignIn('person@example.test', 'secret', send)).rejects.toThrow(
      'not supported',
    )
    send.mockRejectedValue(new Error('private-password'))
    await expect(beginBambuSignIn('person@example.test', 'secret', send)).rejects.toThrow(
      'Could not reach Bambu',
    )
  })
  it('checks tokens server-side and distinguishes expiry from a transient failure', async () => {
    const send = request().mockResolvedValue(response({}))
    expect(await checkBambuToken('own.token', send)).toBe('connected')
    expect(send.mock.calls[0]![1].headers?.Authorization).toBe('Bearer own.token')
    send.mockResolvedValue(response({ code: 4, error: 'Please login.' }, 401))
    expect(await checkBambuToken('own.token', send)).toBe('expired')
    for (const status of [401, 403, 418, 429, 503]) {
      send.mockResolvedValue(response({}, status))
      expect(await checkBambuToken('own.token', send)).toBe('unavailable')
    }
    send.mockResolvedValue(response({ code: 99, error: 'private.secret' }))
    expect(await checkBambuToken('own.token', send)).toBe('unavailable')
  })
})
