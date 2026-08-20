import { describe, expect, it } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import { MAX_CONVERT_TRIANGLES, writeThreeMf } from './threemf'
import { readThreeMf } from '../parse/threemf'
import { MeshParseError, type TriangleVisitor } from '../types'
import { cube, sphere } from '../__fixtures__/shapes'

/**
 * Writing 3MF.
 *
 * The important test is the round trip: what we write is read back by the
 * parser in ../parse, which was written independently against real
 * slicer-exported 3MFs. If the two agree on triangle count and bounding box,
 * the container is structurally sound.
 *
 * The rest is about the parts of the format an importer refuses over — the
 * relationship type, the content types, the build section — because getting
 * those wrong produces a zip that opens perfectly in an archive tool and is
 * rejected by every slicer.
 */

/**
 * Feeds a fixture in, the way a streaming parser would.
 *
 * Fixtures hold one flat Float32Array of 9 floats per triangle, so this hands
 * out a subarray view per triangle rather than copying.
 */
function from(mesh: { triangles: Float32Array; triangleCount: number }) {
  return {
    each(visit: TriangleVisitor) {
      for (let i = 0; i < mesh.triangleCount; i++) {
        visit(mesh.triangles.subarray(i * 9, i * 9 + 9))
      }
    },
  }
}

/** An empty mesh, for the refusal case. */
const nothing = { triangles: new Float32Array(0), triangleCount: 0 }

/** Reads the written archive back through the real parser. */
function readBack(data: Uint8Array) {
  const seen: Float32Array[] = []
  const result = readThreeMf(data, (t) => seen.push(Float32Array.from(t)))
  return { result, seen }
}

describe('writeThreeMf', () => {
  it('round-trips a cube through our own parser', async () => {
    const mesh = cube(20)
    const written = await writeThreeMf(from(mesh))

    expect(written.triangleCount).toBe(mesh.triangleCount)

    const { result } = readBack(written.data)
    expect(result.triangleCount).toBe(mesh.triangleCount)
  })

  it('preserves the bounding box', async () => {
    const written = await writeThreeMf(from(cube(20)))
    const { result } = readBack(written.data)

    expect(result.bbox).not.toBeNull()
    for (const axis of ['minX', 'minY', 'minZ', 'maxX', 'maxY', 'maxZ'] as const) {
      expect(result.bbox![axis]).toBeCloseTo(written.bbox[axis], 3)
    }
  })

  it('round-trips a rounded shape without losing geometry', async () => {
    const mesh = sphere(12, 24, 16)
    const written = await writeThreeMf(from(mesh))
    const { result } = readBack(written.data)

    expect(result.triangleCount).toBe(mesh.triangleCount)
    expect(result.bbox!.maxX - result.bbox!.minX).toBeCloseTo(24, 0)
  })

  /*
   * STL repeats every shared corner; 3MF is indexed. Writing the soup out
   * verbatim would triple the vertex list for no benefit.
   */
  it('deduplicates shared corners', async () => {
    const written = await writeThreeMf(from(cube(10)))
    const xml = strFromU8(unzipSync(written.data)['3D/3dmodel.model']!)

    const vertices = (xml.match(/<vertex /g) ?? []).length
    const triangles = (xml.match(/<triangle /g) ?? []).length

    expect(triangles).toBe(12)
    // A cube has 8 corners however many triangles reference them.
    expect(vertices).toBe(8)
  })

  describe('the parts an importer requires', () => {
    it('contains exactly the three required parts', async () => {
      const written = await writeThreeMf(from(cube(10)))
      const names = Object.keys(unzipSync(written.data)).sort()

      expect(names).toEqual(['3D/3dmodel.model', '[Content_Types].xml', '_rels/.rels'])
    })

    it('declares the 3dmodel content type', async () => {
      const written = await writeThreeMf(from(cube(10)))
      const types = strFromU8(unzipSync(written.data)['[Content_Types].xml']!)

      expect(types).toContain('application/vnd.ms-package.3dmanufacturing-3dmodel+xml')
      expect(types).toContain('Extension="model"')
      expect(types).toContain('Extension="rels"')
    })

    // Wrong relationship type is the classic way to produce a 3MF that opens
    // in an archive tool and is refused by every slicer.
    it('points the root relationship at the model part', async () => {
      const written = await writeThreeMf(from(cube(10)))
      const rels = strFromU8(unzipSync(written.data)['_rels/.rels']!)

      expect(rels).toContain('http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel')
      expect(rels).toContain('Target="/3D/3dmodel.model"')
    })

    it('declares the core namespace and millimetres', async () => {
      const written = await writeThreeMf(from(cube(10)))
      const xml = strFromU8(unzipSync(written.data)['3D/3dmodel.model']!)

      expect(xml).toContain('http://schemas.microsoft.com/3dmanufacturing/core/2015/02')
      expect(xml).toContain('unit="millimeter"')
    })

    /*
     * Without a build item a slicer opens the file, finds no object placed on
     * the plate, and shows an empty scene — which reads as a corrupt file.
     */
    it('places the object on the plate', async () => {
      const written = await writeThreeMf(from(cube(10)))
      const xml = strFromU8(unzipSync(written.data)['3D/3dmodel.model']!)

      expect(xml).toContain('<build><item objectid="1"/></build>')
      expect(xml).toContain('<object id="1" type="model">')
    })

    it('is a real zip, so the extension is not a lie', async () => {
      const written = await writeThreeMf(from(cube(10)))
      // PK\x03\x04
      expect(Array.from(written.data.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04])
    })
  })

  describe('refusals', () => {
    it('refuses an empty mesh rather than writing an empty plate', async () => {
      await expect(writeThreeMf(from(nothing))).rejects.toThrow(MeshParseError)
    })

    it('refuses a mesh too large to hold in memory', async () => {
      const source = {
        each(visit: TriangleVisitor) {
          const triangle = new Float32Array(9)
          for (let i = 0; i <= MAX_CONVERT_TRIANGLES + 1; i++) visit(triangle)
        },
      }
      await expect(writeThreeMf(source)).rejects.toThrow(/too many triangles/i)
    })
  })

  it('compresses, because the coordinates are repetitive text', async () => {
    const written = await writeThreeMf(from(sphere(12, 24, 16)))
    const raw = unzipSync(written.data)['3D/3dmodel.model']!.byteLength

    expect(written.data.byteLength).toBeLessThan(raw)
  })

  it('is deterministic, so the same mesh yields the same bytes', async () => {
    // Matters for caching: the conversion is keyed on the file, and a
    // timestamp in the zip would make every response a different object.
    const first = await writeThreeMf(from(cube(10)))
    const second = await writeThreeMf(from(cube(10)))
    expect(Array.from(second.data)).toEqual(Array.from(first.data))
  })
})
