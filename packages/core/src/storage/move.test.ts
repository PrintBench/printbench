import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { LocalAdapter } from './local-adapter'
import { moveFile } from './move'
import {
  DestinationExistsError,
  PathEscapeError,
  ReadOnlyLibraryError,
  type LibraryLocation,
  type StorageAdapter,
} from './types'

/**
 * Moving a file out of one library and into another.
 *
 * Run against a real filesystem rather than a mock, because the things that
 * can go wrong here — a rename that silently clobbers, a source deleted before
 * the destination is safely written, a path that escapes its root on the way
 * through — are all things a mock would happily pretend went fine.
 */

let base: string
let sourceRoot: string
let destinationRoot: string

const localLibrary = (id: string, root: string, extra?: Partial<LibraryLocation>) =>
  ({
    id,
    kind: 'managed',
    backend: 'local',
    allowWrites: false, // managed libraries are writable regardless
    path: root,
    ...extra,
  }) satisfies LibraryLocation

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'pb-move-'))
  sourceRoot = path.join(base, 'source')
  destinationRoot = path.join(base, 'destination')
  await mkdir(path.join(sourceRoot, 'Red Dragon'), { recursive: true })
  await mkdir(destinationRoot, { recursive: true })
  await writeFile(path.join(sourceRoot, 'Red Dragon', 'body.stl'), 'solid dragon')
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

const source = () => new LocalAdapter(localLibrary('lib-source', sourceRoot))
const destination = () => new LocalAdapter(localLibrary('lib-destination', destinationRoot))

const exists = (absolute: string) =>
  stat(absolute).then(
    () => true,
    () => false,
  )

describe('moving between two local libraries', () => {
  it('puts the file in the destination and takes it out of the source', async () => {
    const outcome = await moveFile(
      source(),
      destination(),
      'Red Dragon/body.stl',
      'Dragons/Red Dragon/body.stl',
    )

    expect(outcome.strategy).toBe('direct')
    expect(
      await readFile(path.join(destinationRoot, 'Dragons', 'Red Dragon', 'body.stl'), 'utf8'),
    ).toBe('solid dragon')
    expect(await exists(path.join(sourceRoot, 'Red Dragon', 'body.stl'))).toBe(false)
  })

  it('creates the destination folders it needs', async () => {
    // The whole point of a move into a fresh library: nothing exists there yet.
    await moveFile(source(), destination(), 'Red Dragon/body.stl', 'a/b/c/d/body.stl')
    expect(await exists(path.join(destinationRoot, 'a', 'b', 'c', 'd', 'body.stl'))).toBe(true)
  })

  it('renames rather than copying, so size does not matter', async () => {
    /*
     * Not a performance assertion dressed up as a test: `adoptFrom` returning
     * true is what the caller reports as a fast move, and a regression that
     * quietly dropped to streaming would still pass every other test here
     * while making a multi-gigabyte move take minutes.
     */
    const adopted = await destination().adoptFrom(source(), 'Red Dragon/body.stl', 'body.stl')
    expect(adopted).toBe(true)
  })

  it('preserves mtime, so the next scan does not re-render the thumbnail', async () => {
    const before = await stat(path.join(sourceRoot, 'Red Dragon', 'body.stl'))

    await moveFile(source(), destination(), 'Red Dragon/body.stl', 'body.stl')

    const after = await stat(path.join(destinationRoot, 'body.stl'))
    expect(Math.floor(after.mtimeMs)).toBe(Math.floor(before.mtimeMs))
  })
})

describe('moving within one library', () => {
  it('moves the file', async () => {
    const adapter = source()
    const outcome = await moveFile(adapter, adapter, 'Red Dragon/body.stl', 'Blue Dragon/body.stl')

    expect(outcome.strategy).toBe('direct')
    expect(await readFile(path.join(sourceRoot, 'Blue Dragon', 'body.stl'), 'utf8')).toBe(
      'solid dragon',
    )
    expect(await exists(path.join(sourceRoot, 'Red Dragon', 'body.stl'))).toBe(false)
  })

  it('is a no-op onto its own path rather than a delete', async () => {
    // Not reachable through moveFile, which refuses an occupied destination
    // before it gets here — but the adapter is public, and on a backend with
    // no rename this is a copy followed by a delete of what was just copied.
    const adapter = source()
    await expect(
      adapter.move('Red Dragon/body.stl', 'Red Dragon/body.stl'),
    ).resolves.toBeUndefined()
    expect(await exists(path.join(sourceRoot, 'Red Dragon', 'body.stl'))).toBe(true)
  })
})

describe('refusals', () => {
  it('refuses to overwrite something already at the destination', async () => {
    await writeFile(path.join(destinationRoot, 'body.stl'), 'someone else’s model')

    await expect(
      moveFile(source(), destination(), 'Red Dragon/body.stl', 'body.stl'),
    ).rejects.toBeInstanceOf(DestinationExistsError)

    // Neither side touched.
    expect(await readFile(path.join(destinationRoot, 'body.stl'), 'utf8')).toBe(
      'someone else’s model',
    )
    expect(await exists(path.join(sourceRoot, 'Red Dragon', 'body.stl'))).toBe(true)
  })

  it('refuses to take a file out of a read-only library', async () => {
    const readOnly = new LocalAdapter({
      ...localLibrary('lib-source', sourceRoot),
      kind: 'in_place',
      allowWrites: false,
    })

    await expect(
      moveFile(readOnly, destination(), 'Red Dragon/body.stl', 'body.stl'),
    ).rejects.toBeInstanceOf(ReadOnlyLibraryError)
    expect(await exists(path.join(sourceRoot, 'Red Dragon', 'body.stl'))).toBe(true)
  })

  it('refuses to write into a read-only library', async () => {
    const readOnly = new LocalAdapter({
      ...localLibrary('lib-destination', destinationRoot),
      kind: 'in_place',
      allowWrites: false,
    })

    await expect(
      moveFile(source(), readOnly, 'Red Dragon/body.stl', 'body.stl'),
    ).rejects.toBeInstanceOf(ReadOnlyLibraryError)
    expect(await exists(path.join(sourceRoot, 'Red Dragon', 'body.stl'))).toBe(true)
  })

  it('allows an in-place library that has explicitly opted in', async () => {
    const optedIn = new LocalAdapter({
      ...localLibrary('lib-destination', destinationRoot),
      kind: 'in_place',
      allowWrites: true,
    })

    await expect(
      moveFile(source(), optedIn, 'Red Dragon/body.stl', 'body.stl'),
    ).resolves.toMatchObject({ strategy: 'direct' })
  })

  it('refuses a destination path that escapes the library', async () => {
    for (const bad of ['../escaped.stl', '/etc/passwd.stl']) {
      await expect(
        moveFile(source(), destination(), 'Red Dragon/body.stl', bad),
        bad,
      ).rejects.toBeInstanceOf(PathEscapeError)
      expect(await exists(path.join(sourceRoot, 'Red Dragon', 'body.stl')), bad).toBe(true)
    }
    expect(await exists(path.join(base, 'escaped.stl'))).toBe(false)
  })

  it('refuses a source path that escapes the library', async () => {
    await writeFile(path.join(base, 'secret.txt'), 'not yours')

    await expect(
      moveFile(source(), destination(), '../secret.txt', 'secret.txt'),
    ).rejects.toBeInstanceOf(PathEscapeError)
    expect(await exists(path.join(base, 'secret.txt'))).toBe(true)
  })
})

describe('the streaming fallback', () => {
  /**
   * A destination with no fast path — what a local-to-S3 move looks like from
   * `moveFile`'s side, without needing a bucket to prove it.
   */
  function streamOnly(root: string): StorageAdapter {
    const real = new LocalAdapter(localLibrary('lib-destination', root))
    return new Proxy(real, {
      get(target, property, receiver) {
        if (property === 'adoptFrom') return undefined
        return Reflect.get(target, property, receiver) as unknown
      },
    }) as StorageAdapter
  }

  it('streams the bytes across and reports having done so', async () => {
    const outcome = await moveFile(
      source(),
      streamOnly(destinationRoot),
      'Red Dragon/body.stl',
      'body.stl',
    )

    expect(outcome.strategy).toBe('streamed')
    expect(await readFile(path.join(destinationRoot, 'body.stl'), 'utf8')).toBe('solid dragon')
    expect(await exists(path.join(sourceRoot, 'Red Dragon', 'body.stl'))).toBe(false)
  })

  it('keeps the source when the write fails', async () => {
    /*
     * The failure that matters most. A move that deletes first and writes
     * second loses the file outright when the destination is full, offline or
     * revoked mid-transfer — so the delete has to be unreachable from here.
     */
    const failing: StorageAdapter = {
      library: localLibrary('lib-destination', destinationRoot),
      stat: async () => null,
      write: async () => {
        throw new Error('bucket unreachable')
      },
    } as unknown as StorageAdapter

    await expect(moveFile(source(), failing, 'Red Dragon/body.stl', 'body.stl')).rejects.toThrow(
      'bucket unreachable',
    )

    expect(await readFile(path.join(sourceRoot, 'Red Dragon', 'body.stl'), 'utf8')).toBe(
      'solid dragon',
    )
  })

  it('leaves the copy in place when the source delete fails', async () => {
    /*
     * Two copies, not zero. Recoverable by hand and — more to the point — the
     * error propagates, so the caller never records a move that only half
     * happened.
     */
    const stubborn = new LocalAdapter(localLibrary('lib-source', sourceRoot))
    stubborn.remove = async () => {
      throw new Error('source is locked')
    }

    await expect(
      moveFile(stubborn, streamOnly(destinationRoot), 'Red Dragon/body.stl', 'body.stl'),
    ).rejects.toThrow('source is locked')

    expect(await readFile(path.join(destinationRoot, 'body.stl'), 'utf8')).toBe('solid dragon')
    expect(await exists(path.join(sourceRoot, 'Red Dragon', 'body.stl'))).toBe(true)
  })

  it('accepts a stream, not a buffer, so a huge file is never held in memory', async () => {
    const seen: unknown[] = []
    const capturing: StorageAdapter = {
      library: localLibrary('lib-destination', destinationRoot),
      stat: async () => null,
      write: async (_path: string, data: unknown) => {
        seen.push(data)
      },
    } as unknown as StorageAdapter

    await moveFile(source(), capturing, 'Red Dragon/body.stl', 'body.stl')

    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeInstanceOf(Readable)
  })
})
