import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/**
 * Encryption at rest for credentials we must be able to read back.
 *
 * Printer API keys cannot be hashed — we have to send the original to the
 * printer — so they are encrypted with AES-256-GCM under a key derived from
 * BETTER_AUTH_SECRET. That means a database dump alone does not hand over
 * everyone's printers, which is the realistic threat for a self-hosted app
 * whose backups end up on a NAS.
 *
 * It is not protection against an attacker who already has the environment:
 * anything the server can decrypt unaided, they can too. Nothing here pretends
 * otherwise.
 */

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16
const PREFIX = 'v1'

export class SecretUnavailableError extends Error {
  constructor() {
    super('BETTER_AUTH_SECRET is not set, so credentials cannot be encrypted.')
    this.name = 'SecretUnavailableError'
  }
}

/** A 32-byte key from a secret of any length. */
function keyFrom(secret: string): Buffer {
  return createHash('sha256').update(`printmanager:secret-box:${secret}`).digest()
}

function requireSecret(secret?: string): string {
  const value = secret ?? process.env.BETTER_AUTH_SECRET
  if (!value) throw new SecretUnavailableError()
  return value
}

/** Returns `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
export function encryptSecret(plaintext: string, secret?: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, keyFrom(requireSecret(secret)), iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return [PREFIX, iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.')
}

/**
 * Returns null rather than throwing on anything malformed.
 *
 * A rotated BETTER_AUTH_SECRET makes every stored credential undecryptable, and
 * that must surface as "re-enter the API key" on one printer, not a crash that
 * takes out the whole admin page.
 */
export function decryptSecret(payload: string | null | undefined, secret?: string): string | null {
  if (!payload) return null

  const parts = payload.split('.')
  if (parts.length !== 4 || parts[0] !== PREFIX) return null

  try {
    const iv = Buffer.from(parts[1]!, 'base64url')
    const tag = Buffer.from(parts[2]!, 'base64url')
    const data = Buffer.from(parts[3]!, 'base64url')
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null

    const decipher = createDecipheriv(ALGORITHM, keyFrom(requireSecret(secret)), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch {
    // Wrong key, or tampered ciphertext — GCM tells us, and either way the
    // answer is the same.
    return null
  }
}

/** `sk-1234…cdef`, for showing that a key is stored without revealing it. */
export function maskSecret(value: string | null): string | null {
  if (!value) return null
  if (value.length <= 8) return '••••'
  return `${value.slice(0, 4)}••••${value.slice(-4)}`
}
