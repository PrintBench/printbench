import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  scryptSync,
  type KeyObject,
} from 'node:crypto'
import { Transform, type TransformCallback } from 'node:stream'
import { z } from 'zod'

/**
 * Encryption for backups that leave the machine.
 *
 * A downloaded backup is the admin's to look after; one written to a bucket
 * on a schedule sits somewhere else indefinitely, holding every email address
 * and password hash on the instance. So those are encrypted whole, not just
 * their stored credentials.
 *
 * The scheme is public-key, so the server can write backups it cannot read:
 *
 *   - When scheduled backups are set up, an X25519 key pair is made. The
 *     public key is stored as it is. The private key is stored only sealed
 *     under a passphrase the admin chooses and the server never keeps.
 *   - Each backup gets a random data key. It is wrapped for the public key
 *     (ECDH with a throwaway key pair, then HKDF) and written into the header.
 *   - The body is AES-256-GCM in 64 KiB chunks, each with its own tag, a
 *     counter nonce and a flag on the last one. A flipped bit, a reordered or
 *     dropped chunk and a truncated file all fail to decrypt, and nothing is
 *     handed on before its chunk has been authenticated.
 *   - Every chunk is bound to a hash of the header, so the plaintext header
 *     (dates and versions, shown in the backup list) cannot be edited either.
 *
 * Each file carries the sealed private key in its header. Restoring needs that
 * file and the passphrase, and nothing from the instance that wrote it — which
 * is the point, because the usual reason to restore is that the instance has
 * gone. The cost is that a stolen file can be attacked offline by guessing the
 * passphrase, which scrypt makes slow and a long passphrase makes hopeless.
 *
 * Someone who takes the running server gets its S3 key and the public key:
 * enough to write new backups, not to read the old ones.
 */

const MAGIC = Buffer.from('PBENC1\n', 'ascii')
const LENGTH_BYTES = 4
/** Generous: a header is about 1 KB. Bounded because it comes from a file. */
const HEADER_MAX_BYTES = 64 * 1024
const CHUNK_BYTES = 64 * 1024
const TAG_BYTES = 16
const IV_BYTES = 12
const KEY_BYTES = 32
const SALT_BYTES = 16
export const ENVELOPE_VERSION = 1

/** The smallest passphrase accepted for scheduled backups. */
export const BACKUP_PASSPHRASE_MIN_LENGTH = 12

/*
 * Stronger than the manual export's scrypt (N = 2^15), because this one key
 * protects every backup in the bucket for as long as they are kept. 64 MB and
 * a fraction of a second, paid once when the key is made and once per restore.
 */
const SCRYPT_PARAMS = { N: 2 ** 16, r: 8, p: 1 }
const SCRYPT_MAXMEM = 256 * 1024 * 1024

const WRAP_INFO = 'printbench-backup/v1/wrap'
const PAYLOAD_INFO = 'printbench-backup/v1/payload'
const SECRETS_INFO = 'printbench-backup/v1/secrets'

const b64 = z
  .string()
  .regex(/^[A-Za-z0-9_-]*$/)
  .max(4096)

const sealedKeySchema = z.object({
  kdf: z.literal('scrypt'),
  N: z
    .number()
    .int()
    .min(2 ** 14)
    .max(2 ** 20),
  r: z.number().int().min(1).max(32),
  p: z.number().int().min(1).max(16),
  salt: b64,
  box: b64,
})

/** The private key, sealed under the passphrase. Safe to store and to publish. */
export type SealedBackupKey = z.infer<typeof sealedKeySchema>

export const envelopeHeaderSchema = z.object({
  envelope: z.literal(ENVELOPE_VERSION),
  createdAt: z.string().max(40),
  appVersion: z.string().max(40).nullable(),
  /** The inner backup's own format version, so a list can say what it holds. */
  backupFormat: z.number().int(),
  migration: z.object({ when: z.number().int(), index: z.number().int() }),
  keyId: z.string().regex(/^[0-9a-f]{16}$/),
  publicKey: b64,
  sealedPrivateKey: sealedKeySchema,
  ephemeralPublicKey: b64,
  wrappedKey: b64,
  chunkBytes: z.literal(CHUNK_BYTES),
})

/** Everything a backup says about itself before it is unlocked. */
export type EnvelopeHeader = z.infer<typeof envelopeHeaderSchema>

export type EnvelopeMeta = Pick<
  EnvelopeHeader,
  'createdAt' | 'appVersion' | 'backupFormat' | 'migration'
>

export interface BackupKeyPair {
  keyId: string
  publicKey: string
  sealedPrivateKey: SealedBackupKey
}

/** A problem with an encrypted backup, safe to show to whoever supplied it. */
export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvelopeError'
  }
}

/** Short and stable, so a list can say which passphrase a backup needs. */
export function backupKeyId(publicKey: string): string {
  return createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex').slice(0, 16)
}

/** Deliberately slow, see SCRYPT_PARAMS. */
function passphraseKey(passphrase: string, sealed: Omit<SealedBackupKey, 'box'>): Buffer {
  return scryptSync(
    passphrase.normalize('NFKC'),
    Buffer.from(sealed.salt, 'base64url'),
    KEY_BYTES,
    {
      N: sealed.N,
      r: sealed.r,
      p: sealed.p,
      maxmem: SCRYPT_MAXMEM,
    },
  )
}

/** Makes the key pair for scheduled backups. The passphrase is not kept. */
export function createBackupKeyPair(passphrase: string): BackupKeyPair {
  if (passphrase.length < BACKUP_PASSPHRASE_MIN_LENGTH) {
    throw new EnvelopeError(
      `Use a passphrase of at least ${BACKUP_PASSPHRASE_MIN_LENGTH} characters.`,
    )
  }
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  const publicRaw = rawPublic(publicKey)
  const salt = randomBytes(SALT_BYTES).toString('base64url')
  const params = { kdf: 'scrypt' as const, ...SCRYPT_PARAMS, salt }
  const privateRaw = Buffer.from(privateKey.export({ format: 'jwk' }).d!, 'base64url')
  const box = seal(
    privateRaw,
    passphraseKey(passphrase, params),
    Buffer.from(publicRaw, 'base64url'),
  )
  return {
    keyId: backupKeyId(publicRaw),
    publicKey: publicRaw,
    sealedPrivateKey: { ...params, box },
  }
}

/** The private key, or null when the passphrase is wrong. */
export function openBackupKey(
  keys: Pick<BackupKeyPair, 'publicKey' | 'sealedPrivateKey'>,
  passphrase: string,
): KeyObject | null {
  let parsed: SealedBackupKey
  try {
    parsed = sealedKeySchema.parse(keys.sealedPrivateKey)
  } catch {
    return null
  }
  const raw = open(
    parsed.box,
    passphraseKey(passphrase, parsed),
    Buffer.from(keys.publicKey, 'base64url'),
  )
  if (!raw || raw.length !== KEY_BYTES) return null
  try {
    return createPrivateKey({
      key: { kty: 'OKP', crv: 'X25519', x: keys.publicKey, d: raw.toString('base64url') },
      format: 'jwk',
    })
  } catch {
    return null
  }
}

export interface EncryptingStream {
  /** Pipe the plaintext backup in and the encrypted file out. */
  stream: Transform
  /**
   * A key derived from this backup's data key, for sealing the credentials
   * inside it. They are then readable by whoever can unlock the file and by
   * no one else, without the server needing the passphrase to write them.
   */
  secretsKey: Buffer
  header: EnvelopeHeader
}

/** Starts an encrypted backup for the given public key. Needs no passphrase. */
export function createEncryptingStream(
  keys: Pick<BackupKeyPair, 'publicKey' | 'sealedPrivateKey'>,
  meta: EnvelopeMeta,
): EncryptingStream {
  const recipient = importPublic(keys.publicKey)
  const ephemeral = generateKeyPairSync('x25519')
  const ephemeralPublic = rawPublic(ephemeral.publicKey)
  const dataKey = randomBytes(KEY_BYTES)
  const wrapKey = deriveWrapKey(
    diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient }),
    ephemeralPublic,
    keys.publicKey,
  )

  const header: EnvelopeHeader = {
    envelope: ENVELOPE_VERSION,
    ...meta,
    keyId: backupKeyId(keys.publicKey),
    publicKey: keys.publicKey,
    sealedPrivateKey: keys.sealedPrivateKey,
    ephemeralPublicKey: ephemeralPublic,
    wrappedKey: seal(dataKey, wrapKey, Buffer.from(ephemeralPublic, 'base64url')),
    chunkBytes: CHUNK_BYTES,
  }
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8')
  const length = Buffer.alloc(LENGTH_BYTES)
  length.writeUInt32BE(headerBytes.length)
  const preamble = Buffer.concat([MAGIC, length, headerBytes])

  return {
    stream: new ChunkSealer(hkdf(dataKey, PAYLOAD_INFO), sha256(headerBytes), preamble),
    secretsKey: hkdf(dataKey, SECRETS_INFO),
    header,
  }
}

/** True when a file's first bytes are an encrypted backup's. */
export function isEncryptedBackup(start: Buffer): boolean {
  return start.length >= MAGIC.length && start.subarray(0, MAGIC.length).equals(MAGIC)
}

/** How many bytes to read from the start of a file to be sure of holding its header. */
export const HEADER_PROBE_BYTES = MAGIC.length + LENGTH_BYTES + HEADER_MAX_BYTES

export interface ParsedHeader {
  header: EnvelopeHeader
  /** The exact bytes the chunks are bound to. */
  headerBytes: Buffer
  /** Where the encrypted body starts. */
  bodyOffset: number
}

/**
 * Reads the header from the start of a file. Throws EnvelopeError if it is
 * not an encrypted backup, or not one this version can read.
 */
export function parseEnvelopeHeader(start: Buffer): ParsedHeader {
  if (!isEncryptedBackup(start))
    throw new EnvelopeError('That is not an encrypted PrintBench backup.')
  if (start.length < MAGIC.length + LENGTH_BYTES) throw new EnvelopeError('The backup is damaged.')
  const length = start.readUInt32BE(MAGIC.length)
  const bodyOffset = MAGIC.length + LENGTH_BYTES + length
  if (length > HEADER_MAX_BYTES || start.length < bodyOffset) {
    throw new EnvelopeError('The backup is damaged.')
  }
  const headerBytes = start.subarray(MAGIC.length + LENGTH_BYTES, bodyOffset)
  let raw: unknown
  try {
    raw = JSON.parse(headerBytes.toString('utf8'))
  } catch {
    throw new EnvelopeError('The backup is damaged.')
  }
  const version = (raw as { envelope?: unknown } | null)?.envelope
  if (typeof version === 'number' && version !== ENVELOPE_VERSION) {
    throw new EnvelopeError(
      `That backup is encrypted with version ${version}; this version of PrintBench reads version ${ENVELOPE_VERSION}.`,
    )
  }
  const parsed = envelopeHeaderSchema.safeParse(raw)
  if (!parsed.success || backupKeyId(parsed.data.publicKey) !== parsed.data.keyId) {
    throw new EnvelopeError('The backup describes itself in a way this version cannot read.')
  }
  return { header: parsed.data, headerBytes: Buffer.from(headerBytes), bodyOffset }
}

export interface UnlockedEnvelope {
  /** Pipe the encrypted body (from bodyOffset) in and the plaintext backup out. */
  decrypt(): Transform
  secretsKey: Buffer
}

/** Null when the passphrase is wrong. */
export function unlockEnvelope(parsed: ParsedHeader, passphrase: string): UnlockedEnvelope | null {
  const { header, headerBytes } = parsed
  const privateKey = openBackupKey(header, passphrase)
  if (!privateKey) return null

  let dataKey: Buffer | null
  try {
    const wrapKey = deriveWrapKey(
      diffieHellman({ privateKey, publicKey: importPublic(header.ephemeralPublicKey) }),
      header.ephemeralPublicKey,
      header.publicKey,
    )
    dataKey = open(header.wrappedKey, wrapKey, Buffer.from(header.ephemeralPublicKey, 'base64url'))
  } catch {
    dataKey = null
  }
  // The passphrase opened the key, so this is a damaged file, not a typo.
  if (!dataKey || dataKey.length !== KEY_BYTES) throw new EnvelopeError('The backup is damaged.')

  const payloadKey = hkdf(dataKey, PAYLOAD_INFO)
  const bound = sha256(headerBytes)
  return {
    decrypt: () => new ChunkOpener(payloadKey, bound),
    secretsKey: hkdf(dataKey, SECRETS_INFO),
  }
}

/* --------------------------------------------------------------- streams */

function chunkNonce(counter: number, last: boolean): Buffer {
  const nonce = Buffer.alloc(IV_BYTES)
  // 11 bytes of counter is far beyond any file; 6 are written, the rest stay zero.
  nonce.writeUIntBE(counter, 5, 6)
  nonce[IV_BYTES - 1] = last ? 1 : 0
  return nonce
}

/**
 * Plaintext in, sealed chunks out. A chunk is only sealed once the next byte
 * has arrived, because the last one is marked as last and that cannot be known
 * any earlier.
 */
class ChunkSealer extends Transform {
  private buffered: Buffer[] = []
  private size = 0
  private counter = 0

  constructor(
    private readonly key: Buffer,
    private readonly bound: Buffer,
    preamble: Buffer,
  ) {
    super()
    this.push(preamble)
  }

  override _transform(chunk: Buffer, _encoding: string, done: TransformCallback) {
    this.buffered.push(chunk)
    this.size += chunk.length
    if (this.size > CHUNK_BYTES) {
      let all = Buffer.concat(this.buffered)
      while (all.length > CHUNK_BYTES) {
        this.push(this.sealChunk(all.subarray(0, CHUNK_BYTES), false))
        all = all.subarray(CHUNK_BYTES)
      }
      this.buffered = [all]
      this.size = all.length
    }
    done()
  }

  override _flush(done: TransformCallback) {
    this.push(this.sealChunk(Buffer.concat(this.buffered), true))
    done()
  }

  private sealChunk(plaintext: Buffer, last: boolean): Buffer {
    const cipher = createCipheriv('aes-256-gcm', this.key, chunkNonce(this.counter++, last))
    cipher.setAAD(this.bound)
    return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
  }
}

/** Sealed chunks in, plaintext out. Fails on the first chunk that does not authenticate. */
class ChunkOpener extends Transform {
  private buffered: Buffer[] = []
  private size = 0
  private counter = 0
  private static readonly SEALED = CHUNK_BYTES + TAG_BYTES

  constructor(
    private readonly key: Buffer,
    private readonly bound: Buffer,
  ) {
    super()
  }

  override _transform(chunk: Buffer, _encoding: string, done: TransformCallback) {
    this.buffered.push(chunk)
    this.size += chunk.length
    if (this.size <= ChunkOpener.SEALED) return done()
    let all = Buffer.concat(this.buffered)
    try {
      while (all.length > ChunkOpener.SEALED) {
        this.push(this.openChunk(all.subarray(0, ChunkOpener.SEALED), false))
        all = all.subarray(ChunkOpener.SEALED)
      }
    } catch (error) {
      return done(error as Error)
    }
    this.buffered = [all]
    this.size = all.length
    done()
  }

  override _flush(done: TransformCallback) {
    try {
      this.push(this.openChunk(Buffer.concat(this.buffered), true))
      done()
    } catch (error) {
      done(error as Error)
    }
  }

  private openChunk(sealed: Buffer, last: boolean): Buffer {
    if (sealed.length < TAG_BYTES) throw new EnvelopeError('The backup is damaged or incomplete.')
    const decipher = createDecipheriv('aes-256-gcm', this.key, chunkNonce(this.counter++, last))
    decipher.setAAD(this.bound)
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES))
    try {
      return Buffer.concat([
        decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)),
        decipher.final(),
      ])
    } catch {
      throw new EnvelopeError('The backup is damaged or incomplete.')
    }
  }
}

/* --------------------------------------------------------------- helpers */

function rawPublic(key: KeyObject): string {
  return key.export({ format: 'jwk' }).x!
}

function importPublic(raw: string): KeyObject {
  try {
    return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw }, format: 'jwk' })
  } catch {
    throw new EnvelopeError('The backup key is damaged.')
  }
}

function deriveWrapKey(shared: Buffer, ephemeralPublic: string, recipientPublic: string): Buffer {
  const salt = Buffer.concat([
    Buffer.from(ephemeralPublic, 'base64url'),
    Buffer.from(recipientPublic, 'base64url'),
  ])
  return Buffer.from(hkdfSync('sha256', shared, salt, WRAP_INFO, KEY_BYTES))
}

function hkdf(key: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), info, KEY_BYTES))
}

function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest()
}

/** `<iv><tag><ciphertext>`, base64url. */
function seal(plaintext: Buffer, key: Buffer, aad: Buffer): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad)
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')
}

function open(payload: string, key: Buffer, aad: Buffer): Buffer | null {
  const data = Buffer.from(payload, 'base64url')
  if (data.length < IV_BYTES + TAG_BYTES) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, IV_BYTES))
    decipher.setAAD(aad)
    decipher.setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
    return Buffer.concat([decipher.update(data.subarray(IV_BYTES + TAG_BYTES)), decipher.final()])
  } catch {
    return null
  }
}
