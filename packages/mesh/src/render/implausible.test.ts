import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { analyzeMesh, renderThumbnail } from './thumbnail'
import {
  MAX_PLAUSIBLE_DIMENSION,
  MeshParseError,
  isImplausiblySized,
  newBox,
  expand,
} from '../types'
import { cube, toBinaryStl, toThreeMf } from '../__fixtures__/shapes'

/**
 * Refusing a file that parses but is not geometry.
 *
 * Random bytes read as a binary STL decode into coordinates at the edge of
 * the Float32 range. Every one is finite, so the degenerate-triangle filter
 * lets them through, and the result is a bounding box ~6.8e38 across.
 *
 * That used to travel all the way to the database, where it overflowed the
 * numeric(12,4) bbox columns and surfaced as a raw driver error saying
 * nothing about the actual problem — while the thumbnail job cheerfully
 * rasterised the same garbage into a meaningless image and cached it forever.
 */

const streamOf = (buffer: Buffer | Uint8Array) => () => Readable.from(Buffer.from(buffer))

describe('isImplausiblySized', () => {
  const boxOf = (size: number) => {
    const box = newBox()
    expand(box, 0, 0, 0)
    expand(box, size, size, size)
    return box
  }

  it('accepts an ordinary model', () => {
    expect(isImplausiblySized(boxOf(250))).toBe(false)
  })

  it('accepts something implausibly large but still describable', () => {
    // Deliberately generous: the threshold exists to catch "not a mesh", not
    // to police size, so anything under it is somebody else's problem.
    expect(isImplausiblySized(boxOf(MAX_PLAUSIBLE_DIMENSION - 1))).toBe(false)
  })

  it('rejects a box past the threshold', () => {
    expect(isImplausiblySized(boxOf(MAX_PLAUSIBLE_DIMENSION + 1))).toBe(true)
  })

  it('rejects one implausible axis even when the others are fine', () => {
    const box = newBox()
    expand(box, 0, 0, 0)
    expand(box, 10, 10, MAX_PLAUSIBLE_DIMENSION * 10)
    expect(isImplausiblySized(box)).toBe(true)
  })

  /*
   * Position is not size. A model exported from a build plate can sit a long
   * way from the origin and still be perfectly ordinary.
   */
  it('judges extent rather than distance from the origin', () => {
    const box = newBox()
    expand(box, 500_000, 500_000, 500_000)
    expand(box, 500_100, 500_100, 500_100)
    expect(isImplausiblySized(box)).toBe(false)
  })

  it('does not call an empty box implausible', () => {
    // No geometry is a different failure, with its own message.
    expect(isImplausiblySized(null)).toBe(false)
    expect(isImplausiblySized(newBox())).toBe(false)
  })
})

describe('analyzeMesh', () => {
  it('still measures a real mesh', async () => {
    const stl = toBinaryStl(cube(20))
    const stats = await analyzeMesh('stl', streamOf(stl), { byteLength: stl.length })
    expect(stats.triangleCount).toBe(12)
  })

  it('refuses random bytes claiming to be an STL', async () => {
    const junk = randomBytes(256 * 1024)
    await expect(analyzeMesh('stl', streamOf(junk), { byteLength: junk.length })).rejects.toThrow(
      MeshParseError,
    )
  })

  it('says what is actually wrong', async () => {
    const junk = randomBytes(256 * 1024)
    // The message reaches the health report and the model page, so it has to
    // read as an explanation rather than as a stack trace.
    await expect(analyzeMesh('stl', streamOf(junk), { byteLength: junk.length })).rejects.toThrow(
      /does not look like a mesh/i,
    )
  })
})

describe('renderThumbnail', () => {
  it('still renders a real mesh', async () => {
    const stl = toBinaryStl(cube(20))
    const result = await renderThumbnail('stl', streamOf(stl), { size: 64, byteLength: stl.length })
    expect(result.data.byteLength).toBeGreaterThan(0)
  })

  /*
   * The worse half of the bug: this path did not error, it succeeded. A
   * content-addressed image of nothing is harder to notice than a failure,
   * and it never regenerates.
   */
  it('refuses to cache an image of garbage', async () => {
    const junk = randomBytes(256 * 1024)
    await expect(
      renderThumbnail('stl', streamOf(junk), { size: 64, byteLength: junk.length }),
    ).rejects.toThrow(MeshParseError)
  })

  /*
   * 3MF reaches the rasteriser without passing through analyzeMesh, so it
   * needs its own guard — the one place a single check would have missed.
   */
  it('refuses an implausible 3MF too', async () => {
    const huge = cube(1)
    // Push one corner out past the threshold, leaving the file structurally
    // valid: this is a parsing success with a nonsensical result.
    huge.triangles[0] = MAX_PLAUSIBLE_DIMENSION * 5
    const packaged = toThreeMf(huge)

    await expect(renderThumbnail('3mf', streamOf(packaged), { size: 64 })).rejects.toThrow(
      /does not look like a mesh/i,
    )
  })
})
