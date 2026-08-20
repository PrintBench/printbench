import { afterEach, describe, expect, it, vi } from 'vitest'
import { SecretUnavailableError, decryptSecret, encryptSecret, maskSecret } from './secret-box'
import { signToken, verifyToken } from './signed-token'

const SECRET = 'a-test-secret-that-is-long-enough'

afterEach(() => {
  vi.useRealTimers()
})

describe('signed tokens', () => {
  it('accepts a token it just minted', () => {
    const { token, expires } = signToken(SECRET, 'file', 'file-1', 60_000)
    expect(verifyToken(SECRET, 'file', 'file-1', token, expires)).toBe(true)
  })

  it('rejects a token for a different subject', () => {
    // Otherwise a link to one file would be a link to every file.
    const { token, expires } = signToken(SECRET, 'file', 'file-1', 60_000)
    expect(verifyToken(SECRET, 'file', 'file-2', token, expires)).toBe(false)
  })

  /*
   * The purpose is signed, so a token minted to read one file cannot be
   * replayed against the upload endpoint — which would otherwise turn a
   * read grant into a write grant.
   */
  it('rejects a token minted for a different purpose', () => {
    const { token, expires } = signToken(SECRET, 'file', 'thing-1', 60_000)
    expect(verifyToken(SECRET, 'upload', 'thing-1', token, expires)).toBe(false)
  })

  it('rejects a token signed with another secret', () => {
    const { token, expires } = signToken('other-secret', 'file', 'file-1', 60_000)
    expect(verifyToken(SECRET, 'file', 'file-1', token, expires)).toBe(false)
  })

  it('rejects a tampered expiry', () => {
    // Moving the deadline is the obvious attack, and it breaks the signature.
    const { token, expires } = signToken(SECRET, 'file', 'file-1', 60_000)
    expect(verifyToken(SECRET, 'file', 'file-1', token, expires + 3_600_000)).toBe(false)
  })

  it('rejects an expired token', () => {
    vi.useFakeTimers()
    const { token, expires } = signToken(SECRET, 'file', 'file-1', 60_000)
    vi.advanceTimersByTime(61_000)
    expect(verifyToken(SECRET, 'file', 'file-1', token, expires)).toBe(false)
  })

  it('rejects a missing or malformed token without throwing', () => {
    // A short token would make timingSafeEqual throw, turning a 403 into a 500.
    const { expires } = signToken(SECRET, 'file', 'file-1', 60_000)
    for (const bad of [null, undefined, '', 'abc', 'x'.repeat(63)]) {
      expect(verifyToken(SECRET, 'file', 'file-1', bad, expires)).toBe(false)
    }
    expect(verifyToken(SECRET, 'file', 'file-1', 'abc', Number.NaN)).toBe(false)
  })
})

describe('credential encryption', () => {
  it('round-trips a value', () => {
    const encrypted = encryptSecret('octoprint-api-key-123', SECRET)
    expect(decryptSecret(encrypted, SECRET)).toBe('octoprint-api-key-123')
  })

  it('does not store the plaintext', () => {
    expect(encryptSecret('super-secret-key', SECRET)).not.toContain('super-secret-key')
  })

  it('produces different ciphertext each time', () => {
    // A fresh IV per encryption: identical keys on two printers must not be
    // visibly identical in the database.
    const a = encryptSecret('same-key', SECRET)
    const b = encryptSecret('same-key', SECRET)
    expect(a).not.toBe(b)
    expect(decryptSecret(a, SECRET)).toBe(decryptSecret(b, SECRET))
  })

  it('handles unicode and empty values', () => {
    expect(decryptSecret(encryptSecret('pässwörd-🔑', SECRET), SECRET)).toBe('pässwörd-🔑')
    expect(decryptSecret(encryptSecret('', SECRET), SECRET)).toBe('')
  })

  /*
   * A rotated secret must surface as "re-enter the API key" on one printer, not
   * as a crash that takes out the admin page.
   */
  it('returns null for a value encrypted under another secret', () => {
    expect(decryptSecret(encryptSecret('key', 'old-secret'), 'new-secret')).toBeNull()
  })

  it('returns null for tampered ciphertext rather than trusting it', () => {
    const encrypted = encryptSecret('key', SECRET)
    const parts = encrypted.split('.')
    parts[3] = Buffer.from('forged-value').toString('base64url')
    expect(decryptSecret(parts.join('.'), SECRET)).toBeNull()
  })

  it('returns null for anything malformed', () => {
    for (const bad of [null, undefined, '', 'not-encrypted', 'v1.a.b', 'v2.a.b.c']) {
      expect(decryptSecret(bad, SECRET)).toBeNull()
    }
  })

  it('refuses to encrypt with no secret configured', () => {
    const previous = process.env.BETTER_AUTH_SECRET
    delete process.env.BETTER_AUTH_SECRET
    try {
      expect(() => encryptSecret('key')).toThrow(SecretUnavailableError)
    } finally {
      if (previous !== undefined) process.env.BETTER_AUTH_SECRET = previous
    }
  })
})

describe('maskSecret', () => {
  it('shows enough to recognise a key without revealing it', () => {
    const masked = maskSecret('ABCD1234567890WXYZ')!
    expect(masked.startsWith('ABCD')).toBe(true)
    expect(masked.endsWith('WXYZ')).toBe(true)
    expect(masked).not.toContain('1234567890')
  })

  it('reveals nothing about a short key', () => {
    expect(maskSecret('short')).toBe('••••')
  })

  it('passes null through', () => {
    expect(maskSecret(null)).toBeNull()
  })
})
