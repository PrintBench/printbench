// @covers BACKUP-002
import { beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  EnvelopeError,
  createBackupKeyPair,
  createEncryptingStream,
  isEncryptedBackup,
  openBackupKey,
  parseEnvelopeHeader,
  unlockEnvelope,
  type BackupKeyPair,
} from './envelope'

/**
 * The rules the backup envelope promises: the right passphrase gets back
 * exactly what went in, and any change to the file — body or header — is
 * refused rather than decrypted into something else.
 */

const PASSPHRASE = 'correct horse battery staple'
const META = {
  createdAt: '2026-11-28T02:30:00.000Z',
  appVersion: '0.11.0',
  backupFormat: 1,
  migration: { when: 1_700_000_000_000, index: 26 },
}
const CHUNK = 64 * 1024

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function encrypt(keys: BackupKeyPair, plaintext: Buffer) {
  const envelope = createEncryptingStream(keys, META)
  const [file] = await Promise.all([
    collect(envelope.stream),
    pipeline(Readable.from([plaintext]), envelope.stream),
  ])
  return { file, secretsKey: envelope.secretsKey }
}

async function decrypt(file: Buffer, passphrase = PASSPHRASE) {
  const parsed = parseEnvelopeHeader(file)
  const unlocked = unlockEnvelope(parsed, passphrase)
  if (!unlocked) return null
  const opener = unlocked.decrypt()
  const [plaintext] = await Promise.all([
    collect(opener),
    pipeline(Readable.from([file.subarray(parsed.bodyOffset)]), opener),
  ])
  return { plaintext, secretsKey: unlocked.secretsKey }
}

describe('backup envelope', () => {
  let keys: BackupKeyPair

  beforeAll(() => {
    keys = createBackupKeyPair(PASSPHRASE)
  })

  it.each([
    ['empty', 0],
    ['shorter than a chunk', 1000],
    ['exactly one chunk', CHUNK],
    ['one byte over a chunk', CHUNK + 1],
    ['several chunks', CHUNK * 3 + 17],
  ])('returns exactly what went in: %s', async (_label, size) => {
    const plaintext = randomBytes(size)
    const { file, secretsKey } = await encrypt(keys, plaintext)
    expect(isEncryptedBackup(file)).toBe(true)

    const opened = await decrypt(file)
    expect(opened?.plaintext.equals(plaintext)).toBe(true)
    // The key credentials inside are sealed with is recoverable from the file.
    expect(opened?.secretsKey.equals(secretsKey)).toBe(true)
  })

  it('says nothing readable in the body', async () => {
    const { file } = await encrypt(keys, Buffer.from('ada@example.com '.repeat(5000)))
    expect(file.includes('ada@example.com')).toBe(false)
  })

  it('refuses a wrong passphrase without throwing', async () => {
    const { file } = await encrypt(keys, Buffer.from('rows'))
    expect(await decrypt(file, 'correct horse battery stapler')).toBeNull()
    expect(openBackupKey(keys, 'not it at all')).toBeNull()
  })

  it('needs only the file and the passphrase, not the instance', async () => {
    const { file } = await encrypt(keys, Buffer.from('rows'))
    // Everything the server stored is gone; the header carries what is needed.
    const parsed = parseEnvelopeHeader(Buffer.from(file))
    expect(parsed.header.keyId).toBe(keys.keyId)
    expect((await decrypt(file))?.plaintext.toString()).toBe('rows')
  })

  it.each([
    ['a flipped bit in the first chunk', (file: Buffer, body: number) => flip(file, body + 10)],
    ['a flipped bit in the last chunk', (file: Buffer) => flip(file, file.length - 3)],
    ['the last chunk cut off', (file: Buffer, body: number) => file.subarray(0, body + CHUNK + 16)],
    ['a few bytes cut off the end', (file: Buffer) => file.subarray(0, file.length - 5)],
    ['bytes added after the end', (file: Buffer) => Buffer.concat([file, Buffer.alloc(40)])],
    [
      'two chunks swapped',
      (file: Buffer, body: number) => {
        const sealed = CHUNK + 16
        const copy = Buffer.from(file)
        file.subarray(body, body + sealed).copy(copy, body + sealed)
        file.subarray(body + sealed, body + 2 * sealed).copy(copy, body)
        return copy
      },
    ],
  ])('refuses %s', async (_label, damage) => {
    const { file } = await encrypt(keys, randomBytes(CHUNK * 3 + 100))
    const body = parseEnvelopeHeader(file).bodyOffset
    await expect(decrypt(damage(file, body))).rejects.toThrow(EnvelopeError)
  })

  it('refuses a header edited to say something else', async () => {
    const { file } = await encrypt(keys, Buffer.from('rows'))
    const edited = Buffer.from(file.toString('latin1').replace('0.11.0', '0.99.0'), 'latin1')
    // Same length, so the header still parses; the chunks are bound to the original.
    expect(parseEnvelopeHeader(edited).header.appVersion).toBe('0.99.0')
    await expect(decrypt(edited)).rejects.toThrow(EnvelopeError)
  })

  it.each([
    ['a ZIP', Buffer.from('PK\x03\x04rest of a zip')],
    ['nothing', Buffer.alloc(0)],
    [
      'a header longer than the file',
      Buffer.concat([Buffer.from('PBENC1\n'), Buffer.from([0, 0, 9, 0])]),
    ],
  ])('refuses to read %s as an encrypted backup', (_label, start) => {
    expect(() => parseEnvelopeHeader(start)).toThrow(EnvelopeError)
  })

  it('refuses a passphrase shorter than the minimum', () => {
    expect(() => createBackupKeyPair('short')).toThrow(EnvelopeError)
  })
})

function flip(file: Buffer, at: number): Buffer {
  const copy = Buffer.from(file)
  copy[at] = copy[at]! ^ 0x01
  return copy
}
