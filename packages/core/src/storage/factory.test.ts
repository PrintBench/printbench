import { describe, expect, it } from 'vitest'
import { createStorageAdapter, libraryLocationFromRow } from './factory'
import { LocalAdapter } from './local-adapter'
import { S3Adapter } from './s3-adapter'
import { encryptSecret } from '../security/secret-box'

/**
 * The switch that used to be duplicated in three routes and one worker job,
 * each written by hand and each hardcoding `local` — which is how S3 stayed
 * completely unreachable even with a working, tested adapter behind it.
 */

const SECRET = 'test-only-secret-do-not-use'

describe('createStorageAdapter', () => {
  it('picks LocalAdapter for a local library', () => {
    const storage = createStorageAdapter({
      id: 'lib-1',
      kind: 'in_place',
      backend: 'local',
      allowWrites: false,
      path: '/libraries/prints',
    })
    expect(storage).toBeInstanceOf(LocalAdapter)
  })

  it('picks S3Adapter for an S3 library', () => {
    const storage = createStorageAdapter({
      id: 'lib-1',
      kind: 'in_place',
      backend: 's3',
      allowWrites: false,
      s3Bucket: 'prints',
    })
    expect(storage).toBeInstanceOf(S3Adapter)
  })

  it('refuses an unknown backend rather than silently defaulting to local', () => {
    expect(() =>
      createStorageAdapter({
        id: 'lib-1',
        kind: 'in_place',
        // @ts-expect-error deliberately invalid
        backend: 'ftp',
        allowWrites: false,
      }),
    ).toThrow(/unknown storage backend/i)
  })
})

describe('libraryLocationFromRow', () => {
  it('never hands the ciphertext to the S3 client', () => {
    process.env.BETTER_AUTH_SECRET ??= SECRET
    const secret = process.env.BETTER_AUTH_SECRET

    const ciphertext = encryptSecret('shh-its-a-secret', secret)
    const location = libraryLocationFromRow({
      id: 'lib-1',
      kind: 'in_place',
      backend: 's3',
      allowWrites: false,
      path: null,
      s3Bucket: 'prints',
      s3SecretAccessKey: ciphertext,
    })

    expect(location.s3SecretAccessKey).toBe('shh-its-a-secret')
    expect(location.s3SecretAccessKey).not.toBe(ciphertext)
  })

  it('passes local libraries through untouched', () => {
    const location = libraryLocationFromRow({
      id: 'lib-1',
      kind: 'in_place',
      backend: 'local',
      allowWrites: false,
      path: '/libraries/prints',
    })
    expect(location.path).toBe('/libraries/prints')
    expect(location.s3SecretAccessKey).toBeNull()
  })
})
