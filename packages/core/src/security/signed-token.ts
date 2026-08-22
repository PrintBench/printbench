import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Short-lived signed tokens, for handing access to something that has no session.
 *
 * Two cases need this. The worker builds ZIPs and receives uploads but has no
 * auth stack at all — authorisation happens in the web tier and is handed over
 * as a signature. And a desktop slicer opening `bambustudio://…?file=https://…`
 * fetches that URL as a separate application, with no cookie of ours.
 *
 * The `purpose` is part of the signed payload, so a token minted to download one
 * file cannot be replayed against the upload endpoint. Every token expires.
 */

export type TokenPurpose = 'file' | 'zip' | 'upload'

export interface SignedToken {
  token: string
  expires: number
}

function payload(purpose: TokenPurpose, subject: string, expires: number): string {
  return `${purpose}:${subject}:${expires}`
}

export function signToken(
  secret: string,
  purpose: TokenPurpose,
  subject: string,
  ttlMs: number,
): SignedToken {
  const expires = Date.now() + ttlMs
  return {
    token: createHmac('sha256', secret)
      .update(payload(purpose, subject, expires))
      .digest('hex'),
    expires,
  }
}

/**
 * True only for a token that is intact, for this exact purpose and subject, and
 * not yet expired.
 *
 * Compared in constant time, and length-checked first because timingSafeEqual
 * throws rather than returning false when the buffers differ in length — which
 * would turn a malformed token into a 500 instead of a 403.
 */
export function verifyToken(
  secret: string,
  purpose: TokenPurpose,
  subject: string,
  token: string | null | undefined,
  expires: number,
): boolean {
  if (!token || !Number.isFinite(expires)) return false
  if (Date.now() > expires) return false

  const expected = Buffer.from(
    createHmac('sha256', secret)
      .update(payload(purpose, subject, expires))
      .digest('hex'),
  )
  const actual = Buffer.from(token)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
