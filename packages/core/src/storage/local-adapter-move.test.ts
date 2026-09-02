import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The cross-filesystem half of a local move.
 *
 * `rename` cannot cross a volume boundary, and a library on internal disk
 * moving a model to one on a NAS mount is not an edge case — it is half the
 * reason to have two libraries. That path is hand-written (copy, restore the
 * mtime, then remove) and every step of it can lose a file, so it is mocked
 * into existence here rather than left to whoever happens to run the tests on
 * a machine with two filesystems.
 */

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: vi.fn(async () => {
      const error: NodeJS.ErrnoException = new Error('cross-device link not permitted')
      error.code = 'EXDEV'
      throw error
    }),
  }
})

// Static, despite the mock above: vi.mock is hoisted past these, so they see
// the mocked `rename` and the real everything else.
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { LocalAdapter } from './local-adapter'
import { moveFile } from './move'
import { ReadOnlyLibraryError, type LibraryLocation } from './types'

let base: string
let sourceRoot: string
let destinationRoot: string

/** Well in the past, so a copy taking the current time is unmistakable. */
const ORIGINAL_MTIME = new Date('2021-06-01T10:00:00.000Z')

const library = (id: string, root: string): LibraryLocation => ({
  id,
  kind: 'managed',
  backend: 'local',
  allowWrites: false,
  path: root,
})

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'pb-move-xdev-'))
  sourceRoot = path.join(base, 'source')
  destinationRoot = path.join(base, 'destination')
  await mkdir(sourceRoot, { recursive: true })
  await mkdir(destinationRoot, { recursive: true })
  await writeFile(path.join(sourceRoot, 'body.stl'), 'solid dragon')
  await utimes(path.join(sourceRoot, 'body.stl'), ORIGINAL_MTIME, ORIGINAL_MTIME)
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

const exists = (absolute: string) =>
  stat(absolute).then(
    () => true,
    () => false,
  )

describe('a move across a filesystem boundary', () => {
  it('copies the file over and removes the original', async () => {
    await moveFile(
      new LocalAdapter(library('lib-source', sourceRoot)),
      new LocalAdapter(library('lib-destination', destinationRoot)),
      'body.stl',
      'Dragons/body.stl',
    )

    expect(await readFile(path.join(destinationRoot, 'Dragons', 'body.stl'), 'utf8')).toBe(
      'solid dragon',
    )
    expect(await exists(path.join(sourceRoot, 'body.stl'))).toBe(false)
  })

  it('carries the mtime over, so no thumbnail is re-rendered for identical bytes', async () => {
    /*
     * A copy gives the new file the current time, which the next scan reads as
     * "changed" — re-queueing analysis and a fresh render for bytes that were
     * already rendered. Free to avoid, and invisible until someone wonders why
     * moving a library churned through thousands of thumbnails.
     */
    await moveFile(
      new LocalAdapter(library('lib-source', sourceRoot)),
      new LocalAdapter(library('lib-destination', destinationRoot)),
      'body.stl',
      'body.stl',
    )

    const moved = await stat(path.join(destinationRoot, 'body.stl'))
    expect(Math.floor(moved.mtimeMs)).toBe(ORIGINAL_MTIME.getTime())
  })

  it('keeps the original when the copy fails', async () => {
    // Deleting before the copy is confirmed is how this path loses a file.
    // A destination the copy cannot write to stands in for a full disk.
    const destination = new LocalAdapter(library('lib-destination', destinationRoot))
    const source = new LocalAdapter(library('lib-source', sourceRoot))

    await expect(destination.adoptFrom(source, 'body.stl', 'nope/../../body.stl')).rejects.toThrow()
    expect(await readFile(path.join(sourceRoot, 'body.stl'), 'utf8')).toBe('solid dragon')
  })

  it('still refuses a read-only source', async () => {
    // The fallback is a different code path; the promise holds down it too.
    const readOnly = new LocalAdapter({
      ...library('lib-source', sourceRoot),
      kind: 'in_place',
      allowWrites: false,
    })

    await expect(
      moveFile(
        readOnly,
        new LocalAdapter(library('lib-destination', destinationRoot)),
        'body.stl',
        'body.stl',
      ),
    ).rejects.toBeInstanceOf(ReadOnlyLibraryError)
    expect(await exists(path.join(sourceRoot, 'body.stl'))).toBe(true)
  })
})
