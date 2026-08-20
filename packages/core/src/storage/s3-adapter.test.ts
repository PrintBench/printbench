import { describe, expect, it } from 'vitest'
import { S3Adapter, describeS3Error } from './s3-adapter'
import { PathEscapeError, ReadOnlyLibraryError, StorageUnavailableError } from './types'
import type { LibraryLocation } from './types'

/**
 * The S3 adapter's decisions, without a bucket.
 *
 * Key construction and the read-only guard are the parts that can lose or
 * expose data, and both are pure. Talking to a real bucket is what
 * scripts/verify-phase8.mts does against MinIO when one is available.
 */

const base: LibraryLocation = {
  id: 'lib-1',
  kind: 'in_place',
  backend: 's3',
  allowWrites: false,
  s3Bucket: 'prints',
  s3Prefix: 'models',
  s3Region: 'eu-west-2',
}

/** keyFor is private; exercised through the errors and behaviour it drives. */
function keyOf(adapter: S3Adapter, path: string): string {
  return (adapter as unknown as { keyFor: (p: string) => string }).keyFor(path)
}

describe('construction', () => {
  it('refuses a library that is not S3-backed', () => {
    expect(() => new S3Adapter({ ...base, backend: 'local' })).toThrow(StorageUnavailableError)
  })

  it('refuses a library with no bucket', () => {
    expect(() => new S3Adapter({ ...base, s3Bucket: null })).toThrow(StorageUnavailableError)
  })

  it('accepts a bucket with no prefix', () => {
    expect(() => new S3Adapter({ ...base, s3Prefix: null })).not.toThrow()
  })
})

describe('key construction', () => {
  it('puts the prefix in front', () => {
    const adapter = new S3Adapter(base)
    expect(keyOf(adapter, 'Dragon/body.stl')).toBe('models/Dragon/body.stl')
  })

  it('works with no prefix at all', () => {
    const adapter = new S3Adapter({ ...base, s3Prefix: null })
    expect(keyOf(adapter, 'Dragon/body.stl')).toBe('Dragon/body.stl')
  })

  /*
   * A prefix with a leading or trailing slash produces "/models/x.stl" or
   * "models//x.stl" — both legal in S3 and both completely different keys from
   * the intended one.
   */
  it('normalises an awkward prefix', () => {
    for (const prefix of ['/models', 'models/', '/models/', 'models']) {
      const adapter = new S3Adapter({ ...base, s3Prefix: prefix })
      expect(keyOf(adapter, 'a.stl'), prefix).toBe('models/a.stl')
    }
  })

  it('normalises backslashes, which Windows produces', () => {
    const adapter = new S3Adapter(base)
    expect(keyOf(adapter, 'Dragon\\body.stl')).toBe('models/Dragon/body.stl')
  })

  it('normalises unicode to NFC', () => {
    const adapter = new S3Adapter(base)
    // "Pokémon" decomposed must not become a different key from the composed
    // form, or the same file is two objects.
    expect(keyOf(adapter, 'Pokémon/x.stl')).toBe('models/Pokémon/x.stl')
  })

  /*
   * The guard runs on the raw input, before normalisation. Normalising first is
   * the bug that keeps recurring in this codebase — it turns an escaping path
   * into one that looks contained.
   */
  it('refuses a path that escapes the prefix', () => {
    const adapter = new S3Adapter(base)
    for (const bad of ['../secrets.txt', 'a/../../b.stl', '/etc/passwd', '..\\..\\x']) {
      expect(() => keyOf(adapter, bad), bad).toThrow(PathEscapeError)
    }
  })
})

describe('the read-only promise', () => {
  it('refuses to write to an in-place library', async () => {
    const adapter = new S3Adapter(base)
    await expect(adapter.write('a.stl', 'data')).rejects.toThrow(ReadOnlyLibraryError)
    await expect(adapter.remove('a.stl')).rejects.toThrow(ReadOnlyLibraryError)
  })

  it('refuses before touching the network', async () => {
    // The bucket does not exist, so a request would fail with something else
    // entirely. Getting ReadOnlyLibraryError proves nothing was attempted.
    const adapter = new S3Adapter({ ...base, s3Bucket: 'no-such-bucket-at-all' })
    await expect(adapter.write('a.stl', 'x')).rejects.toThrow(ReadOnlyLibraryError)
  })

  it('allows writes to a managed library', () => {
    const adapter = new S3Adapter({ ...base, kind: 'managed', allowWrites: true })
    // Not awaited: this would reach the network. Only the guard is under test,
    // and it throws synchronously ahead of the request.
    expect(() =>
      (adapter as unknown as { assertWritable: () => void }).assertWritable(),
    ).not.toThrow()
  })

  it('allows writes to an in-place library that opted in', () => {
    const adapter = new S3Adapter({ ...base, allowWrites: true })
    expect(() =>
      (adapter as unknown as { assertWritable: () => void }).assertWritable(),
    ).not.toThrow()
  })
})

describe('error messages', () => {
  const cases: [string, unknown, RegExp][] = [
    ['a missing bucket', { name: 'NoSuchBucket' }, /does not exist/i],
    ['a bad access key', { name: 'InvalidAccessKeyId' }, /not recognised/i],
    ['a bad secret', { name: 'SignatureDoesNotMatch' }, /does not match/i],
    ['denied access', { name: 'AccessDenied' }, /not allowed/i],
    ['the wrong region', { name: 'PermanentRedirect' }, /region/i],
    ['a timeout', { name: 'TimeoutError' }, /did not respond/i],
    ['a bad hostname', { cause: { code: 'ENOTFOUND' } }, /resolve/i],
    ['a refused connection', { cause: { code: 'ECONNREFUSED' } }, /refused/i],
  ]

  for (const [label, error, expected] of cases) {
    it(`explains ${label}`, () => {
      expect(describeS3Error(error, 'prints')).toMatch(expected)
    })
  }

  it('names the bucket, so a typo is obvious', () => {
    expect(describeS3Error({ name: 'NoSuchBucket' }, 'prnits')).toContain('prnits')
  })

  it('falls back to the underlying message', () => {
    expect(describeS3Error(new Error('something specific'), 'prints')).toBe('something specific')
  })

  it('reads an HTTP status when there is no error name', () => {
    expect(describeS3Error({ $metadata: { httpStatusCode: 403 } }, 'prints')).toMatch(/not allowed/i)
  })
})
