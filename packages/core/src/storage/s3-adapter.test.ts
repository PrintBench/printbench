import { describe, expect, it, vi } from 'vitest'
import { CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { S3Adapter, copySource, describeS3Error, sameEndpoint } from './s3-adapter'
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

/**
 * Moves, without a bucket.
 *
 * The client is stubbed so the commands the adapter builds can be inspected
 * directly: which bucket each one names, and - the part that decides whether a
 * move is a move or a duplication - that the delete goes to the SOURCE and
 * happens after the copy.
 */
function stubClient(adapter: S3Adapter, contentLength = 1024) {
  const sent: { name: string; input: Record<string, unknown> }[] = []
  const send = vi.fn(async (command: unknown) => {
    const name = (command as object).constructor.name
    sent.push({ name, input: (command as { input: Record<string, unknown> }).input })
    return name === 'HeadObjectCommand' ? { ContentLength: contentLength } : {}
  })
  ;(adapter as unknown as { client: { send: unknown } }).client = { send }
  return sent
}

const managed = (extra: Partial<LibraryLocation> = {}) =>
  new S3Adapter({ ...base, kind: 'managed', ...extra })

describe('moving within one bucket', () => {
  it('copies then deletes, in that order', async () => {
    const adapter = managed()
    const sent = stubClient(adapter)

    await adapter.move('Dragon/body.stl', 'Dragons/Red/body.stl')

    expect(sent.map((command) => command.name)).toEqual([
      HeadObjectCommand.name,
      CopyObjectCommand.name,
      DeleteObjectCommand.name,
    ])
    expect(sent[1]!.input).toMatchObject({
      Bucket: 'prints',
      Key: 'models/Dragons/Red/body.stl',
      CopySource: 'prints/models/Dragon/body.stl',
    })
    // The delete names the OLD key. Naming the new one deletes what was just
    // copied and leaves the original - a move that achieves nothing, twice.
    expect(sent[2]!.input).toMatchObject({ Bucket: 'prints', Key: 'models/Dragon/body.stl' })
  })

  it('does nothing at all when the destination is the source', async () => {
    // Copy-then-delete onto the same key deletes the object outright. There is
    // no rename to fall back on here, so the guard is the only thing stopping
    // it.
    const adapter = managed()
    const sent = stubClient(adapter)

    await adapter.move('Dragon/body.stl', 'Dragon/body.stl')

    expect(sent).toEqual([])
  })

  it('streams an object too big for a single CopyObject', async () => {
    const adapter = managed()
    const sent = stubClient(adapter, 6 * 1024 * 1024 * 1024)
    const write = vi.fn(async () => {})
    Object.assign(adapter, { write, createReadStream: async () => 'stream' })

    await adapter.move('Dragon/huge.stl', 'Dragon/moved.stl')

    expect(sent.map((command) => command.name)).toEqual([
      HeadObjectCommand.name,
      DeleteObjectCommand.name,
    ])
    expect(write).toHaveBeenCalledOnce()
  })

  it('refuses a move out of a read-only library, before any request', async () => {
    const adapter = new S3Adapter(base)
    const sent = stubClient(adapter)
    await expect(adapter.move('a.stl', 'b.stl')).rejects.toThrow(ReadOnlyLibraryError)
    expect(sent).toEqual([])
  })
})

describe('adopting from another S3 library', () => {
  it('copies server-side across buckets on the same endpoint', async () => {
    const destination = managed({ s3Bucket: 'archive', s3Prefix: null })
    const source = managed({ s3Bucket: 'prints' })
    const sent = stubClient(destination)
    const sourceSent = stubClient(source)

    expect(await destination.adoptFrom(source, 'Dragon/body.stl', 'Dragon/body.stl')).toBe(true)

    expect(sent[1]!.input).toMatchObject({
      Bucket: 'archive',
      Key: 'Dragon/body.stl',
      CopySource: 'prints/models/Dragon/body.stl',
    })
    // Deleted through the SOURCE's own client, which is the one holding its
    // credentials - and from the source bucket, not the destination.
    expect(sourceSent.at(-1)).toMatchObject({
      name: DeleteObjectCommand.name,
      input: { Bucket: 'prints', Key: 'models/Dragon/body.stl' },
    })
  })

  it('declines a source on a different endpoint', async () => {
    // One request, signed once, has to read both buckets. A different endpoint
    // or key pair cannot - so say so and let the caller stream instead.
    const destination = managed()
    for (const elsewhere of [
      { s3Endpoint: 'https://other.example' },
      { s3Region: 'us-east-1' },
      { s3AccessKeyId: 'someone-else' },
    ]) {
      const sent = stubClient(destination)
      expect(await destination.adoptFrom(managed(elsewhere), 'a.stl', 'a.stl')).toBe(false)
      expect(sent).toEqual([])
    }
  })

  it('declines a local source', async () => {
    const destination = managed()
    const local = { library: { id: 'x', backend: 'local' } } as never
    expect(await destination.adoptFrom(local, 'a.stl', 'a.stl')).toBe(false)
  })

  it('declines rather than copying when the object is too large', async () => {
    const destination = managed({ s3Bucket: 'archive' })
    stubClient(destination, 6 * 1024 * 1024 * 1024)
    const source = managed()
    const sourceSent = stubClient(source)

    expect(await destination.adoptFrom(source, 'huge.stl', 'huge.stl')).toBe(false)
    // Declining has to leave the source alone: the caller is about to stream
    // it, and a source already deleted has nothing left to stream.
    expect(sourceSent).toEqual([])
  })

  it('refuses when either library is read-only', async () => {
    const readOnlyDestination = new S3Adapter(base)
    await expect(readOnlyDestination.adoptFrom(managed(), 'a.stl', 'a.stl')).rejects.toThrow(
      ReadOnlyLibraryError,
    )

    const destination = managed({ s3Bucket: 'archive' })
    stubClient(destination)
    await expect(destination.adoptFrom(new S3Adapter(base), 'a.stl', 'a.stl')).rejects.toThrow(
      ReadOnlyLibraryError,
    )
  })
})

describe('copy sources', () => {
  it('names the bucket and key', () => {
    expect(copySource('prints', 'models/Dragon/body.stl')).toBe('prints/models/Dragon/body.stl')
  })

  /*
   * CopySource is URL-decoded by S3. A raw "+" comes back as a space, so the
   * copy fails with NoSuchKey for a file that is plainly sitting there - and
   * "Dragon + Wings" is an entirely ordinary folder name.
   */
  it('encodes characters that would otherwise be decoded into something else', () => {
    expect(copySource('prints', 'Dragon + Wings/body #2.stl')).toBe(
      'prints/Dragon%20%2B%20Wings/body%20%232.stl',
    )
  })

  it('leaves the separators alone, so the key still points at the same object', () => {
    expect(copySource('prints', 'a/b/c.stl')).toBe('prints/a/b/c.stl')
  })
})

describe('reachability with one set of credentials', () => {
  it('accepts two libraries on the same endpoint, region and key', () => {
    expect(sameEndpoint(base, { ...base, s3Bucket: 'other', s3Prefix: 'elsewhere' })).toBe(true)
  })

  it('treats an absent endpoint and a null one as the same', () => {
    // "Not set" means AWS proper for both; they are the same place.
    expect(sameEndpoint({ ...base, s3Endpoint: null }, { ...base })).toBe(true)
  })

  it('rejects a difference in any of the three', () => {
    expect(sameEndpoint(base, { ...base, s3Endpoint: 'https://minio.local' })).toBe(false)
    expect(sameEndpoint(base, { ...base, s3Region: 'us-east-1' })).toBe(false)
    expect(sameEndpoint(base, { ...base, s3AccessKeyId: 'other' })).toBe(false)
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
    expect(describeS3Error({ $metadata: { httpStatusCode: 403 } }, 'prints')).toMatch(
      /not allowed/i,
    )
  })
})
