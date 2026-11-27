// @contract core/storage-factory
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
  const connection = {
    bucket: 'prints',
    endpoint: 'https://minio.example.com',
    region: 'eu-west-2',
    accessKeyId: 'AKIA',
    secretAccessKey: null as string | null,
    forcePathStyle: true,
  }

  it('never hands the ciphertext to the S3 client', () => {
    process.env.BETTER_AUTH_SECRET ??= SECRET
    const secret = process.env.BETTER_AUTH_SECRET

    const ciphertext = encryptSecret('shh-its-a-secret', secret)
    const location = libraryLocationFromRow(
      {
        id: 'lib-1',
        kind: 'in_place',
        backend: 's3',
        allowWrites: false,
        path: null,
      },
      { ...connection, secretAccessKey: ciphertext },
    )

    expect(location.s3SecretAccessKey).toBe('shh-its-a-secret')
    expect(location.s3SecretAccessKey).not.toBe(ciphertext)
  })

  it('takes the bucket and credentials from the connection and the prefix from the library', () => {
    const location = libraryLocationFromRow(
      {
        id: 'lib-1',
        kind: 'managed',
        backend: 's3',
        allowWrites: true,
        path: null,
        s3Prefix: 'models',
      },
      connection,
    )

    expect(location).toMatchObject({
      s3Bucket: 'prints',
      s3Prefix: 'models',
      s3Endpoint: 'https://minio.example.com',
      s3Region: 'eu-west-2',
      s3AccessKeyId: 'AKIA',
      s3ForcePathStyle: true,
    })
  })

  it('leaves an S3 library with no connection without a bucket, so the adapter refuses it', () => {
    const location = libraryLocationFromRow(
      { id: 'lib-1', kind: 'in_place', backend: 's3', allowWrites: false, path: null },
      null,
    )
    expect(location.s3Bucket).toBeNull()
    expect(() => createStorageAdapter(location)).toThrow(/no bucket/i)
  })

  it('passes local libraries through untouched, ignoring any connection', () => {
    const location = libraryLocationFromRow(
      {
        id: 'lib-1',
        kind: 'in_place',
        backend: 'local',
        allowWrites: false,
        path: '/libraries/prints',
      },
      connection,
    )
    expect(location.path).toBe('/libraries/prints')
    expect(location.s3Bucket).toBeNull()
    expect(location.s3SecretAccessKey).toBeNull()
  })
})
