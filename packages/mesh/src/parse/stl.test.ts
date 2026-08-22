import { describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import { detectStlFormat, readStl } from './stl'
import { MeshParseError } from '../types'
import {
  cube,
  degenerateSoup,
  expectedBounds,
  sphere,
  toAsciiStl,
  toBinaryStl,
  torus,
} from '../__fixtures__/shapes'

/** Streams a buffer in fixed-size chunks, so chunk-boundary handling is exercised. */
function chunked(buffer: Buffer, chunkSize: number) {
  return () =>
    Readable.from(
      (function* () {
        for (let i = 0; i < buffer.length; i += chunkSize) {
          yield buffer.subarray(i, i + chunkSize)
        }
      })(),
    )
}

const collect = () => {
  const seen: number[][] = []
  // The visitor is handed a REUSED array, so copy before keeping it.
  return { seen, visit: (t: Float32Array) => seen.push([...t]) }
}

describe('detectStlFormat', () => {
  /*
   * The trap this exists for: plenty of exporters (SolidWorks, Magics) write
   * the word "solid" into the 80-byte binary header, so the usual
   * "starts with solid therefore ASCII" check silently produces garbage.
   */
  it('identifies a binary STL whose header starts with "solid"', () => {
    const buffer = toBinaryStl(cube(), 'solid COMPANY_EXPORTER v1.2')
    expect(detectStlFormat(buffer.subarray(0, 100), buffer.length)).toBe('binary')
  })

  it('identifies a genuine ASCII STL', () => {
    const buffer = toAsciiStl(cube())
    expect(detectStlFormat(buffer.subarray(0, 200), buffer.length)).toBe('ascii')
  })

  it('identifies a binary STL with an ordinary header', () => {
    const buffer = toBinaryStl(cube())
    expect(detectStlFormat(buffer.subarray(0, 100), buffer.length)).toBe('binary')
  })
})

describe('readStl (binary)', () => {
  it('reads every triangle with the correct bounding box', async () => {
    const mesh = cube(10)
    const buffer = toBinaryStl(mesh)
    const { seen, visit } = collect()

    const stats = await readStl(chunked(buffer, 64 * 1024), visit, { byteLength: buffer.length })

    expect(stats.triangleCount).toBe(12)
    expect(seen).toHaveLength(12)
    expect(stats.bbox).toMatchObject({ minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 10, maxZ: 10 })
  })

  it('handles a binary header that says "solid"', async () => {
    const buffer = toBinaryStl(cube(10), 'solid EXPORTED_BY_SOMETHING')
    const { visit } = collect()
    const stats = await readStl(chunked(buffer, 4096), visit, { byteLength: buffer.length })
    // Misdetected as ASCII this yields zero triangles.
    expect(stats.triangleCount).toBe(12)
  })

  /*
   * A 50-byte record never aligns to a stream chunk. Reading at many awkward
   * sizes is the cheapest way to prove the carry-over logic is right.
   */
  it('reassembles triangles split across chunk boundaries', async () => {
    const mesh = sphere(5, 12, 8)
    const buffer = toBinaryStl(mesh)

    for (const chunkSize of [1, 7, 13, 49, 50, 51, 83, 84, 85, 128, 999]) {
      const { seen, visit } = collect()
      const stats = await readStl(chunked(buffer, chunkSize), visit, { byteLength: buffer.length })
      expect(stats.triangleCount, `chunk size ${chunkSize}`).toBe(mesh.triangleCount)
      expect(seen.length, `chunk size ${chunkSize}`).toBe(mesh.triangleCount)
    }
  })

  it('matches an independently computed bounding box', async () => {
    const mesh = torus(6, 2, 16, 8)
    const buffer = toBinaryStl(mesh)
    const expected = expectedBounds(mesh)

    const stats = await readStl(chunked(buffer, 8192), () => {}, { byteLength: buffer.length })

    expect(stats.bbox!.minX).toBeCloseTo(expected.minX, 4)
    expect(stats.bbox!.maxX).toBeCloseTo(expected.maxX, 4)
    expect(stats.bbox!.minZ).toBeCloseTo(expected.minZ, 4)
    expect(stats.bbox!.maxZ).toBeCloseTo(expected.maxZ, 4)
  })

  it('reports a truncated file rather than pretending it is whole', async () => {
    const buffer = toBinaryStl(cube())
    const cut = buffer.subarray(0, buffer.length - 50 * 4) // lose 4 triangles
    const stats = await readStl(chunked(cut, 512), () => {}, { byteLength: cut.length })

    expect(stats.triangleCount).toBe(8)
    expect(stats.truncated).toBe(true)
  })

  it('does not hold the mesh in memory', async () => {
    // 20k triangles is ~1 MB of STL. Peak heap must not scale with it.
    const mesh = sphere(5, 100, 100)
    const buffer = toBinaryStl(mesh)
    expect(mesh.triangleCount).toBeGreaterThan(19_000)

    global.gc?.()
    const before = process.memoryUsage().heapUsed
    const stats = await readStl(chunked(buffer, 64 * 1024), () => {}, { byteLength: buffer.length })
    const after = process.memoryUsage().heapUsed

    expect(stats.triangleCount).toBe(mesh.triangleCount)
    // Generous bound: the point is that it is bounded, not proportional.
    expect(after - before).toBeLessThan(20 * 1024 * 1024)
  })
})

describe('readStl (ascii)', () => {
  it('reads every triangle with the correct bounding box', async () => {
    const buffer = toAsciiStl(cube(10))
    const { seen, visit } = collect()

    const stats = await readStl(chunked(buffer, 4096), visit, { byteLength: buffer.length })

    expect(stats.triangleCount).toBe(12)
    expect(seen).toHaveLength(12)
    expect(stats.bbox).toMatchObject({ minX: 0, maxX: 10, minZ: 0, maxZ: 10 })
  })

  it('reassembles vertices split across chunk boundaries', async () => {
    const mesh = sphere(5, 8, 6)
    const buffer = toAsciiStl(mesh)

    for (const chunkSize of [1, 3, 17, 64, 4096]) {
      const stats = await readStl(chunked(buffer, chunkSize), () => {}, {
        byteLength: buffer.length,
      })
      expect(stats.triangleCount, `chunk size ${chunkSize}`).toBe(mesh.triangleCount)
    }
  })

  it('copes with CRLF line endings', async () => {
    const buffer = Buffer.from(
      toAsciiStl(cube()).toString('latin1').replace(/\n/g, '\r\n'),
      'latin1',
    )
    const stats = await readStl(chunked(buffer, 512), () => {}, { byteLength: buffer.length })
    expect(stats.triangleCount).toBe(12)
  })

  it('handles negative and exponent-notation coordinates', async () => {
    const text = [
      'solid t',
      '  facet normal 0 0 0',
      '    outer loop',
      '      vertex -1.5e1 0 0',
      '      vertex 2.5E-1 -3 0',
      '      vertex 0 0 1e2',
      '    endloop',
      '  endfacet',
      'endsolid t',
    ].join('\n')
    const buffer = Buffer.from(text, 'latin1')

    const stats = await readStl(chunked(buffer, 32), () => {}, { byteLength: buffer.length })

    expect(stats.triangleCount).toBe(1)
    expect(stats.bbox).toMatchObject({ minX: -15, maxZ: 100, minY: -3 })
  })
})

describe('robustness', () => {
  /*
   * Real exporters emit zero-area slivers and the occasional NaN. One bad
   * triangle must not poison the bounding box — that is how a whole model ends
   * up rendered as a dot in the corner of its thumbnail.
   */
  it('skips degenerate triangles without corrupting the bounds', async () => {
    const mesh = degenerateSoup()
    const buffer = toBinaryStl(mesh)
    const { seen, visit } = collect()

    const stats = await readStl(chunked(buffer, 256), visit, { byteLength: buffer.length })

    expect(stats.triangleCount).toBe(1) // only the one good triangle
    expect(stats.degenerateCount).toBe(5)
    expect(seen).toHaveLength(1)

    // NaN and Infinity never reached the bounding box.
    for (const value of Object.values(stats.bbox!)) {
      expect(Number.isFinite(value)).toBe(true)
    }
    expect(stats.bbox).toMatchObject({ minX: 0, minY: 0, maxX: 10, maxY: 10 })
  })

  it('throws on a file with no triangles at all', async () => {
    const buffer = Buffer.from('solid empty\nendsolid empty\n', 'latin1')
    await expect(
      readStl(chunked(buffer, 64), () => {}, { byteLength: buffer.length }),
    ).rejects.toBeInstanceOf(MeshParseError)
  })

  it('can be aborted mid-parse', async () => {
    const buffer = toBinaryStl(sphere(5, 60, 60))
    const controller = new AbortController()
    let count = 0

    await expect(
      readStl(
        chunked(buffer, 1024),
        () => {
          if (++count > 100) controller.abort()
        },
        { byteLength: buffer.length, signal: controller.signal },
      ),
    ).rejects.toThrow()
  })

  it('reuses one array across the whole walk', async () => {
    const buffer = toBinaryStl(cube())
    const arrays = new Set<Float32Array>()
    await readStl(chunked(buffer, 4096), (t) => arrays.add(t), { byteLength: buffer.length })
    // Allocating per triangle would dominate the cost on a 120M-triangle mesh.
    expect(arrays.size).toBe(1)
  })
})
