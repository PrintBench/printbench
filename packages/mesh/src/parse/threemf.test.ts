import { describe, expect, it } from 'vitest'
import { readThreeMf } from './threemf'
import { MeshParseError } from '../types'
import { cube, degenerateSoup, fakePng, sphere, toThreeMf } from '../__fixtures__/shapes'

const collect = () => {
  const seen: number[][] = []
  return { seen, visit: (t: Float32Array) => seen.push([...t]) }
}

describe('readThreeMf', () => {
  it('resolves indexed geometry into triangles', async () => {
    const { seen, visit } = collect()
    const stats = readThreeMf(toThreeMf(cube(10)), visit)

    expect(stats.triangleCount).toBe(12)
    expect(seen).toHaveLength(12)
    expect(stats.bbox).toMatchObject({ minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 10, maxZ: 10 })
  })

  it('handles a larger indexed mesh', () => {
    const mesh = sphere(5, 16, 12)
    const stats = readThreeMf(toThreeMf(mesh), () => {})
    expect(stats.triangleCount).toBe(mesh.triangleCount)
  })

  describe('units', () => {
    /*
     * Unlike STL, 3MF declares its units. Normalising to millimetres here means
     * the dimensions shown in the UI are trustworthy rather than a guess.
     */
    it('normalises millimetres unchanged', () => {
      const stats = readThreeMf(toThreeMf(cube(10), { unit: 'millimeter' }), () => {})
      expect(stats.bbox!.maxX).toBeCloseTo(10, 4)
      expect(stats.unit).toBe('mm')
    })

    it('converts inches to millimetres', () => {
      const stats = readThreeMf(toThreeMf(cube(1), { unit: 'inch' }), () => {})
      expect(stats.bbox!.maxX).toBeCloseTo(25.4, 3)
    })

    it('converts centimetres to millimetres', () => {
      const stats = readThreeMf(toThreeMf(cube(1), { unit: 'centimeter' }), () => {})
      expect(stats.bbox!.maxX).toBeCloseTo(10, 4)
    })

    it('converts microns to millimetres', () => {
      const stats = readThreeMf(toThreeMf(cube(1000), { unit: 'micron' }), () => {})
      expect(stats.bbox!.maxX).toBeCloseTo(1, 4)
    })
  })

  describe('embedded thumbnails', () => {
    /*
     * Worth the effort: a slicer-exported 3MF usually carries a real plate
     * render, which beats anything we would rasterise and costs nothing.
     */
    it('extracts the thumbnail named by the OPC relationship', () => {
      const png = fakePng(42)
      const result = readThreeMf(
        toThreeMf(cube(), { thumbnail: { path: 'Metadata/thumbnail.png', data: png } }),
        () => {},
      )
      expect(result.thumbnail?.path).toBe('Metadata/thumbnail.png')
      expect(result.thumbnail?.contentType).toBe('image/png')
      expect([...result.thumbnail!.data]).toEqual([...png])
    })

    it('finds a thumbnail at a non-standard path via the relationship', () => {
      // Slicers disagree on where this goes; the relationship is authoritative.
      const result = readThreeMf(
        toThreeMf(cube(), { thumbnail: { path: 'Metadata/plate_1.png', data: fakePng(7) } }),
        () => {},
      )
      expect(result.thumbnail?.path).toBe('Metadata/plate_1.png')
    })

    it('falls back to conventional paths when no relationship exists', () => {
      const result = readThreeMf(
        toThreeMf(cube(), {
          withoutRels: true,
          thumbnail: { path: 'Metadata/thumbnail.png', data: fakePng(3) },
        }),
        () => {},
      )
      expect(result.thumbnail?.path).toBe('Metadata/thumbnail.png')
    })

    it('prefers a plate render over a generic image', () => {
      const result = readThreeMf(
        toThreeMf(cube(), {
          withoutRels: true,
          extraImages: {
            'Metadata/plate_1.png': fakePng(1),
            'Metadata/thumbnail.png': fakePng(2),
            'random/other.png': fakePng(3),
          },
        }),
        () => {},
      )
      expect(result.thumbnail?.path).toBe('Metadata/plate_1.png')
    })

    it('returns no thumbnail when the package has none', () => {
      const result = readThreeMf(toThreeMf(cube()), () => {})
      expect(result.thumbnail).toBeUndefined()
    })

    it('ignores a zero-byte thumbnail', () => {
      const result = readThreeMf(
        toThreeMf(cube(), {
          withoutRels: true,
          extraImages: { 'Metadata/thumbnail.png': new Uint8Array(0) },
        }),
        () => {},
      )
      expect(result.thumbnail).toBeUndefined()
    })
  })

  describe('robustness', () => {
    it('skips triangles referencing vertices that do not exist', () => {
      const { seen, visit } = collect()
      // A corrupt index must be skipped, never read out of bounds.
      const stats = readThreeMf(toThreeMf(cube(), { corruptIndex: true }), visit)
      expect(stats.triangleCount).toBe(12)
      expect(seen).toHaveLength(12)
    })

    it('skips degenerate triangles without corrupting the bounds', () => {
      const stats = readThreeMf(toThreeMf(degenerateSoup()), () => {})
      expect(stats.triangleCount).toBe(1)
      for (const value of Object.values(stats.bbox!)) {
        expect(Number.isFinite(value)).toBe(true)
      }
    })

    it('rejects something that is not a zip', () => {
      expect(() => readThreeMf(new TextEncoder().encode('not a zip at all'), () => {})).toThrow(
        MeshParseError,
      )
    })

    it('rejects a zip with no model part', () => {
      // A valid package that simply is not a 3MF.
      const notA3mf = toThreeMf(cube())
      const stripped = notA3mf.slice(0, 40) // corrupt it
      expect(() => readThreeMf(stripped, () => {})).toThrow(MeshParseError)
    })

    it('reuses one array across the whole walk', () => {
      const arrays = new Set<Float32Array>()
      readThreeMf(toThreeMf(cube()), (t) => arrays.add(t))
      expect(arrays.size).toBe(1)
    })
  })
})
