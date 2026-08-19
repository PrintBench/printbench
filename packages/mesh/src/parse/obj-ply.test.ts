import { describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import { readObj } from './obj'
import { readPly } from './ply'
import { MeshParseError } from '../types'
import {
  cube,
  degenerateSoup,
  expectedBounds,
  sphere,
  toAsciiPly,
  toBinaryPly,
  toObj,
} from '../__fixtures__/shapes'

function chunked(buffer: Buffer, chunkSize = 4096) {
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
  return { seen, visit: (t: Float32Array) => seen.push([...t]) }
}

describe('readObj', () => {
  it('reads faces with the correct bounding box', async () => {
    const { seen, visit } = collect()
    const buffer = toObj(cube(10))
    const stats = await readObj(chunked(buffer), visit)

    expect(stats.triangleCount).toBe(12)
    expect(seen).toHaveLength(12)
    expect(stats.bbox).toMatchObject({ minX: 0, maxX: 10, minZ: 0, maxZ: 10 })
  })

  it('reassembles lines split across chunk boundaries', async () => {
    const mesh = sphere(5, 10, 8)
    const buffer = toObj(mesh)
    for (const chunkSize of [1, 7, 64, 4096]) {
      const stats = await readObj(chunked(buffer, chunkSize), () => {})
      expect(stats.triangleCount, `chunk ${chunkSize}`).toBe(mesh.triangleCount)
    }
  })

  /*
   * Quads are extremely common in OBJ exports. Handling only 3-vertex faces
   * makes such a model render as nothing at all, which looks like a broken
   * thumbnail rather than an unsupported format.
   */
  it('triangulates quads and n-gons', async () => {
    const text = [
      'v 0 0 0',
      'v 1 0 0',
      'v 1 1 0',
      'v 0 1 0',
      'f 1 2 3 4', // a quad
    ].join('\n')
    const stats = await readObj(chunked(Buffer.from(text)), () => {})
    expect(stats.triangleCount).toBe(2)

    const pentagon = [
      'v 0 0 0', 'v 2 0 0', 'v 3 1 0', 'v 1 2 0', 'v -1 1 0',
      'f 1 2 3 4 5',
    ].join('\n')
    const five = await readObj(chunked(Buffer.from(pentagon)), () => {})
    expect(five.triangleCount).toBe(3)
  })

  it('handles v/vt/vn face syntax', async () => {
    const text = [
      'v 0 0 0', 'v 1 0 0', 'v 0 1 0',
      'vt 0 0', 'vn 0 0 1',
      'f 1/1/1 2/1/1 3/1/1',
    ].join('\n')
    const stats = await readObj(chunked(Buffer.from(text)), () => {})
    expect(stats.triangleCount).toBe(1)
  })

  it('handles v//vn face syntax', async () => {
    const text = ['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'vn 0 0 1', 'f 1//1 2//1 3//1'].join('\n')
    const stats = await readObj(chunked(Buffer.from(text)), () => {})
    expect(stats.triangleCount).toBe(1)
  })

  it('handles negative (relative) indices', async () => {
    // -1 means "the most recently defined vertex", used by several exporters.
    const text = ['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f -3 -2 -1'].join('\n')
    const stats = await readObj(chunked(Buffer.from(text)), () => {})
    expect(stats.triangleCount).toBe(1)
    expect(stats.bbox).toMatchObject({ minX: 0, maxX: 1 })
  })

  it('ignores comments, groups and material directives', async () => {
    const text = [
      '# a comment',
      'mtllib thing.mtl',
      'o Object001',
      'g group1',
      's off',
      'usemtl red',
      'v 0 0 0', 'v 1 0 0', 'v 0 1 0',
      'f 1 2 3',
    ].join('\n')
    const stats = await readObj(chunked(Buffer.from(text)), () => {})
    expect(stats.triangleCount).toBe(1)
  })

  it('skips faces referencing vertices that do not exist', async () => {
    const text = ['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f 1 2 999', 'f 1 2 3'].join('\n')
    const stats = await readObj(chunked(Buffer.from(text)), () => {})
    expect(stats.triangleCount).toBe(1)
  })

  it('skips degenerate faces without corrupting the bounds', async () => {
    const stats = await readObj(chunked(toObj(degenerateSoup())), () => {})
    expect(stats.triangleCount).toBe(1)
    for (const value of Object.values(stats.bbox!)) expect(Number.isFinite(value)).toBe(true)
  })

  it('throws when there are no faces', async () => {
    const buffer = Buffer.from('v 0 0 0\nv 1 0 0\n')
    await expect(readObj(chunked(buffer), () => {})).rejects.toBeInstanceOf(MeshParseError)
  })

  it('refuses a file that would exhaust memory', async () => {
    const buffer = toObj(cube())
    await expect(readObj(chunked(buffer), () => {}, { maxVertices: 4 })).rejects.toBeInstanceOf(
      MeshParseError,
    )
  })
})

describe('readPly', () => {
  it('reads an ASCII PLY', async () => {
    const { seen, visit } = collect()
    const stats = await readPly(chunked(toAsciiPly(cube(10))), visit)

    expect(stats.triangleCount).toBe(12)
    expect(seen).toHaveLength(12)
    expect(stats.bbox).toMatchObject({ minX: 0, maxX: 10, minZ: 0, maxZ: 10 })
  })

  it('reads a binary little-endian PLY', async () => {
    const { seen, visit } = collect()
    const stats = await readPly(chunked(toBinaryPly(cube(10))), visit)

    expect(stats.triangleCount).toBe(12)
    expect(seen).toHaveLength(12)
    expect(stats.bbox).toMatchObject({ minX: 0, maxX: 10, minZ: 0, maxZ: 10 })
  })

  it('matches an independently computed bounding box', async () => {
    const mesh = sphere(5, 12, 10)
    const expected = expectedBounds(mesh)
    const stats = await readPly(chunked(toBinaryPly(mesh)), () => {})

    expect(stats.bbox!.minX).toBeCloseTo(expected.minX, 3)
    expect(stats.bbox!.maxZ).toBeCloseTo(expected.maxZ, 3)
  })

  /*
   * Scanner output carries colour, normal and confidence channels alongside
   * position. Every property must be read to keep the byte offset correct,
   * even though only x/y/z are kept.
   */
  it('skips extra vertex properties without losing alignment', async () => {
    const header = [
      'ply',
      'format binary_little_endian 1.0',
      'element vertex 3',
      'property float x',
      'property float y',
      'property float z',
      'property uchar red',
      'property uchar green',
      'property uchar blue',
      'element face 1',
      'property list uchar int vertex_indices',
      'end_header',
      '',
    ].join('\n')

    const body = Buffer.alloc(3 * 15 + 13)
    const points = [
      [0, 0, 0],
      [10, 0, 0],
      [0, 20, 0],
    ]
    let offset = 0
    for (const [x, y, z] of points) {
      body.writeFloatLE(x!, offset)
      body.writeFloatLE(y!, offset + 4)
      body.writeFloatLE(z!, offset + 8)
      body.writeUInt8(255, offset + 12)
      body.writeUInt8(128, offset + 13)
      body.writeUInt8(64, offset + 14)
      offset += 15
    }
    body.writeUInt8(3, offset)
    body.writeInt32LE(0, offset + 1)
    body.writeInt32LE(1, offset + 5)
    body.writeInt32LE(2, offset + 9)

    const buffer = Buffer.concat([Buffer.from(header, 'latin1'), body])
    const stats = await readPly(chunked(buffer), () => {})

    expect(stats.triangleCount).toBe(1)
    // Colour bytes misread as coordinates would give wildly wrong bounds.
    expect(stats.bbox).toMatchObject({ minX: 0, maxX: 10, minY: 0, maxY: 20 })
  })

  it('triangulates quad faces', async () => {
    const text = [
      'ply', 'format ascii 1.0',
      'element vertex 4',
      'property float x', 'property float y', 'property float z',
      'element face 1',
      'property list uchar int vertex_indices',
      'end_header',
      '0 0 0', '1 0 0', '1 1 0', '0 1 0',
      '4 0 1 2 3',
      '',
    ].join('\n')
    const stats = await readPly(chunked(Buffer.from(text, 'latin1')), () => {})
    expect(stats.triangleCount).toBe(2)
  })

  /*
   * Big-endian PLY is rare but real. Silently reading it as little-endian
   * produces nonsense geometry, so refuse it explicitly.
   */
  it('refuses big-endian PLY rather than misreading it', async () => {
    const text = ['ply', 'format binary_big_endian 1.0', 'end_header', ''].join('\n')
    await expect(readPly(chunked(Buffer.from(text, 'latin1')), () => {})).rejects.toThrow(
      /big-endian/i,
    )
  })

  it('rejects a file that is not a PLY', async () => {
    await expect(
      readPly(chunked(Buffer.from('this is not a ply file at all')), () => {}),
    ).rejects.toBeInstanceOf(MeshParseError)
  })
})
