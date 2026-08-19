import { describe, expect, it } from 'vitest'
import { signDownloadToken, verifyDownloadToken } from './zip'

/**
 * The ZIP endpoint lives in the worker, which has no session cookie and no auth
 * stack. The web process signs a short-lived token instead, so the two
 * processes stay independent while the endpoint remains impossible to call
 * without having been authorised first.
 */
const SECRET = 'test-secret-at-least-32-characters-long'
const MODEL = '11111111-2222-4333-8444-555555555555'

const future = () => Date.now() + 60_000
const past = () => Date.now() - 1000

describe('download tokens', () => {
  it('accepts a token it just issued', () => {
    const expires = future()
    const token = signDownloadToken(MODEL, expires, SECRET)
    expect(verifyDownloadToken(MODEL, expires, token, SECRET)).toBe(true)
  })

  it('rejects an expired token', () => {
    const expires = past()
    const token = signDownloadToken(MODEL, expires, SECRET)
    // Correctly signed, but the link has timed out.
    expect(verifyDownloadToken(MODEL, expires, token, SECRET)).toBe(false)
  })

  /*
   * The token binds the model id. Without that, a link for a model you may see
   * could be edited into a link for one you may not.
   */
  it('rejects a token issued for a different model', () => {
    const expires = future()
    const token = signDownloadToken(MODEL, expires, SECRET)
    const other = '99999999-8888-4777-8666-555555555555'
    expect(verifyDownloadToken(other, expires, token, SECRET)).toBe(false)
  })

  it('rejects a token whose expiry has been extended', () => {
    const expires = future()
    const token = signDownloadToken(MODEL, expires, SECRET)
    // Editing the expiry in the URL must invalidate the signature.
    expect(verifyDownloadToken(MODEL, expires + 60_000, token, SECRET)).toBe(false)
  })

  it('rejects a token signed with a different secret', () => {
    const expires = future()
    const token = signDownloadToken(MODEL, expires, 'some-other-secret-entirely-abc')
    expect(verifyDownloadToken(MODEL, expires, token, SECRET)).toBe(false)
  })

  it('rejects malformed tokens without throwing', () => {
    const expires = future()
    for (const bad of ['', 'nonsense', 'a'.repeat(64), '0'.repeat(63)]) {
      expect(() => verifyDownloadToken(MODEL, expires, bad, SECRET)).not.toThrow()
      expect(verifyDownloadToken(MODEL, expires, bad, SECRET)).toBe(false)
    }
  })

  it('rejects a non-numeric expiry', () => {
    const token = signDownloadToken(MODEL, Number.NaN, SECRET)
    expect(verifyDownloadToken(MODEL, Number.NaN, token, SECRET)).toBe(false)
  })

  it('produces a different signature per model', () => {
    const expires = future()
    const a = signDownloadToken(MODEL, expires, SECRET)
    const b = signDownloadToken('22222222-2222-4333-8444-555555555555', expires, SECRET)
    expect(a).not.toBe(b)
  })
})
