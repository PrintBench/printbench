import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

/**
 * Encryption under a passphrase, for the credentials inside a backup.
 *
 * Stored credentials are encrypted with a key derived from BETTER_AUTH_SECRET,
 * which a second instance does not share. So a backup carries them re-encrypted
 * under a passphrase its owner chose, and the restoring instance re-encrypts
 * them under its own secret.
 *
 * scrypt rather than a plain hash because, unlike BETTER_AUTH_SECRET, a
 * passphrase is something a person typed and can be guessed.
 */

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16
const SALT_BYTES = 16
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const VERIFIER_TEXT = 'printbench-backup'

export function newSalt(): string {
  return randomBytes(SALT_BYTES).toString('base64url')
}

/** Deliberately slow. Derive once per backup and reuse the key. */
export function deriveKey(passphrase: string, salt: string): Buffer {
  return scryptSync(passphrase.normalize('NFKC'), Buffer.from(salt, 'base64url'), 32, SCRYPT)
}

/** Returns `<iv>.<tag>.<ciphertext>`, all base64url. */
export function seal(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.')
}

/** Null for a wrong key or anything malformed, never a throw. */
export function open(payload: string, key: Buffer): string | null {
  const parts = payload.split('.')
  if (parts.length !== 3) return null
  try {
    const [iv, tag, data] = parts.map((part) => Buffer.from(part, 'base64url')) as [
      Buffer,
      Buffer,
      Buffer,
    ]
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null
    const decipher = createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

/** A known value sealed with the key, so a wrong passphrase is caught up front. */
export function makeVerifier(key: Buffer): string {
  return seal(VERIFIER_TEXT, key)
}

export function checkVerifier(verifier: string, key: Buffer): boolean {
  return open(verifier, key) === VERIFIER_TEXT
}
