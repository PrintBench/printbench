import { describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import sharp from 'sharp'
import { Rasterizer, RENDERER_VERSION, isRenderable } from './rasterizer'
import { renderThumbnail, supportedFormat } from './thumbnail'
import { newBox, type BoundingBox } from '../types'
import {
  cube,
  fakePng,
  plate,
  sphere,
  toAsciiStl,
  toBinaryStl,
  toObj,
  toThreeMf,
  torus,
  type Mesh,
} from '../__fixtures__/shapes'

function boxOf(mesh: Mesh): BoundingBox {
  const box = newBox()
  for (let i = 0; i < mesh.triangleCount * 3; i++) {
    const x = mesh.triangles[i * 3]!
    const y = mesh.triangles[i * 3 + 1]!
    const z = mesh.triangles[i * 3 + 2]!
    box.minX = Math.min(box.minX, x); box.maxX = Math.max(box.maxX, x)
    box.minY = Math.min(box.minY, y); box.maxY = Math.max(box.maxY, y)
    box.minZ = Math.min(box.minZ, z); box.maxZ = Math.max(box.maxZ, z)
  }
  return box
}

/** Draws a whole mesh and returns the raw supersampled target. */
function render(mesh: Mesh, options = {}) {
  const rasterizer = new Rasterizer(boxOf(mesh), { size: 64, supersample: 2, ...options })
  const triangle = new Float32Array(9)
  for (let i = 0; i < mesh.triangleCount; i++) {
    triangle.set(mesh.triangles.subarray(i * 9, i * 9 + 9))
    rasterizer.addTriangle(triangle)
  }
  return rasterizer.finish()
}

/** Fraction of pixels that are not fully transparent. */
function coverage(target: { pixels: Uint8ClampedArray }): number {
  let covered = 0
  for (let i = 3; i < target.pixels.length; i += 4) {
    if (target.pixels[i]! > 0) covered++
  }
  return covered / (target.pixels.length / 4)
}

/** Bounding box of the drawn pixels, in the target's own coordinates. */
function drawnBounds(target: { width: number; height: number; pixels: Uint8ClampedArray }) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let y = 0; y < target.height; y++) {
    for (let x = 0; x < target.width; x++) {
      if (target.pixels[(y * target.width + x) * 4 + 3]! > 0) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x)
        minY = Math.min(minY, y); maxY = Math.max(maxY, y)
      }
    }
  }
  return { minX, minY, maxX, maxY }
}

const streamOf = (buffer: Buffer) => () => Readable.from([buffer])

describe('Rasterizer', () => {
  it('draws a cube', () => {
    const target = render(cube(10))
    expect(target.drawn).toBe(true)
    // A cube viewed from three-quarters fills a good share of the frame.
    expect(coverage(target)).toBeGreaterThan(0.3)
    expect(coverage(target)).toBeLessThan(0.9)
  })

  it('draws a sphere as a filled disc', () => {
    const target = render(sphere(5, 24, 16))
    expect(target.drawn).toBe(true)

    // Measured against its own silhouette rather than the whole canvas: the
    // camera is fitted to the bounding box, which for a sphere is a cube, so
    // there is legitimate slack around it before the crop step.
    const bounds = drawnBounds(target)
    const side = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY)
    const covered = coverage(target) * target.width * target.height
    // A disc fills about pi/4 of its bounding square.
    expect(covered / (side * side)).toBeGreaterThan(0.7)
    expect(covered / (side * side)).toBeLessThan(0.85)
  })

  it('draws a torus, including the hole', () => {
    const target = render(torus(6, 2, 32, 16))
    expect(target.drawn).toBe(true)

    const bounds = drawnBounds(target)
    const side = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY)
    const covered = coverage(target) * target.width * target.height
    // Noticeably less than a disc: the middle is empty.
    expect(covered / (side * side)).toBeLessThan(0.72)
    expect(covered / (side * side)).toBeGreaterThan(0.25)
  })

  it('centres the model in the frame', () => {
    const target = render(sphere(5, 24, 16), { size: 64, supersample: 1 })
    const bounds = drawnBounds(target)

    const centreX = (bounds.minX + bounds.maxX) / 2
    const centreY = (bounds.minY + bounds.maxY) / 2
    expect(Math.abs(centreX - target.width / 2)).toBeLessThan(target.width * 0.06)
    expect(Math.abs(centreY - target.height / 2)).toBeLessThan(target.height * 0.06)
  })

  it('never draws outside the canvas', () => {
    const bounds = drawnBounds(render(torus(6, 2, 24, 12), { size: 64, supersample: 1 }))
    expect(bounds.minX).toBeGreaterThanOrEqual(0)
    expect(bounds.minY).toBeGreaterThanOrEqual(0)
    expect(bounds.maxX).toBeLessThan(64)
    expect(bounds.maxY).toBeLessThan(64)
  })

  it('reports the bounds of what it drew', () => {
    const target = render(cube(10), { size: 64, supersample: 1 })
    const measured = drawnBounds(target)
    // These bounds drive the crop, so they must match reality exactly.
    expect(target.bounds).toEqual(measured)
  })

  it('frames a tiny model and a huge one identically', () => {
    // Scale invariance matters: a 2 mm bolt and a 300 mm dragon should both
    // fill their thumbnail rather than appearing as a dot or overflowing.
    const small = drawnBounds(render(sphere(0.5, 16, 12), { size: 64, supersample: 1 }))
    const large = drawnBounds(render(sphere(500, 16, 12), { size: 64, supersample: 1 }))

    expect(small.maxX - small.minX).toBeCloseTo(large.maxX - large.minX, 0)
    expect(small.maxY - small.minY).toBeCloseTo(large.maxY - large.minY, 0)
  })

  it('renders a model far from the origin the same as one at it', () => {
    // Models exported from a build plate are often offset by hundreds of mm.
    const atOrigin = render(cube(10), { size: 64, supersample: 1 })
    const offsetMesh = cube(10)
    for (let i = 0; i < offsetMesh.triangles.length; i += 3) {
      offsetMesh.triangles[i] = offsetMesh.triangles[i]! + 1000
      offsetMesh.triangles[i + 1] = offsetMesh.triangles[i + 1]! - 500
    }
    const offset = render(offsetMesh, { size: 64, supersample: 1 })

    expect(coverage(offset)).toBeCloseTo(coverage(atOrigin), 2)
  })

  it('draws a flat plate without dividing by zero', () => {
    // Zero extent on one axis is a real case: coasters, name plates, gaskets.
    const target = render(plate(20))
    expect(target.drawn).toBe(true)
    expect(coverage(target)).toBeGreaterThan(0.1)
    for (const value of target.pixels) expect(Number.isFinite(value)).toBe(true)
  })

  it('is deterministic', () => {
    const first = render(torus(6, 2, 16, 8))
    const second = render(torus(6, 2, 16, 8))
    // Byte-identical output is what makes golden-image testing possible at all.
    expect(Buffer.from(first.pixels)).toEqual(Buffer.from(second.pixels))
  })

  it('shades faces differently so form is readable', () => {
    const target = render(cube(10), { size: 32, supersample: 1 })
    const shades = new Set<string>()
    for (let i = 0; i < target.pixels.length; i += 4) {
      if (target.pixels[i + 3]! > 0) {
        shades.add(`${target.pixels[i]},${target.pixels[i + 1]},${target.pixels[i + 2]}`)
      }
    }
    // Three faces are visible from a three-quarter view; a single flat colour
    // would mean the lighting is not working.
    expect(shades.size).toBeGreaterThanOrEqual(3)
  })

  /*
   * Print meshes very often have inconsistent winding. Backface culling would
   * punch holes straight through such a model, so faces are drawn two-sided
   * with the normal flipped towards the camera.
   */
  it('draws correctly regardless of triangle winding', () => {
    const normal = cube(10)
    const flipped: Mesh = {
      triangleCount: normal.triangleCount,
      triangles: new Float32Array(normal.triangles.length),
    }
    for (let i = 0; i < normal.triangleCount; i++) {
      const t = normal.triangles.subarray(i * 9, i * 9 + 9)
      // Swap vertices b and c to reverse the winding.
      flipped.triangles.set([...t.subarray(0, 3), ...t.subarray(6, 9), ...t.subarray(3, 6)], i * 9)
    }

    const a = render(normal, { size: 48, supersample: 1 })
    const b = render(flipped, { size: 48, supersample: 1 })
    expect(coverage(b)).toBeCloseTo(coverage(a), 2)
  })

  it('respects the transparent background by default', () => {
    const target = render(cube(10), { size: 32, supersample: 1 })
    // Corner pixels are outside the model.
    expect(target.pixels[3]).toBe(0)
  })

  it('honours an opaque background when asked', () => {
    const target = render(cube(10), { size: 32, supersample: 1, background: [1, 1, 1, 1] })
    expect(target.pixels[3]).toBe(255)
    expect(target.pixels[0]).toBe(255)
  })

  it('keeps memory flat regardless of triangle count', () => {
    const box: BoundingBox = { minX: -5, minY: -5, minZ: -5, maxX: 5, maxY: 5, maxZ: 5 }
    const rasterizer = new Rasterizer(box, { size: 64, supersample: 2 })

    global.gc?.()
    const before = process.memoryUsage().heapUsed

    // Half a million triangles, drawn one at a time and never retained.
    const triangle = new Float32Array(9)
    for (let i = 0; i < 500_000; i++) {
      const a = (i % 100) / 10 - 5
      triangle.set([a, -5, -5, a + 0.5, 5, -5, a, 0, 5])
      rasterizer.addTriangle(triangle)
    }

    const after = process.memoryUsage().heapUsed
    // The buffers are allocated up front; the loop must add nothing.
    expect(after - before).toBeLessThan(16 * 1024 * 1024)
  })
})

describe('isRenderable', () => {
  it('rejects nothing to draw', () => {
    expect(isRenderable(null)).toBe(false)
    expect(isRenderable(newBox())).toBe(false)
    // A single point has no extent.
    expect(isRenderable({ minX: 1, minY: 1, minZ: 1, maxX: 1, maxY: 1, maxZ: 1 })).toBe(false)
  })

  it('accepts a flat plate', () => {
    expect(isRenderable({ minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 10, maxZ: 0 })).toBe(true)
  })
})

describe('renderThumbnail', () => {
  it('produces a real WebP from a binary STL', async () => {
    const buffer = toBinaryStl(sphere(5, 20, 14))
    const result = await renderThumbnail('stl', streamOf(buffer), {
      size: 128,
      byteLength: buffer.length,
    })

    expect(result.contentType).toBe('image/webp')
    expect(result.embedded).toBe(false)
    expect(result.rendererVersion).toBe(RENDERER_VERSION)

    const meta = await sharp(result.data).metadata()
    expect(meta.format).toBe('webp')
    expect(meta.width).toBe(128)
    expect(meta.height).toBe(128)
  })

  it('produces a PNG when asked', async () => {
    const buffer = toBinaryStl(cube(10))
    const result = await renderThumbnail('stl', streamOf(buffer), {
      size: 64,
      format: 'png',
      byteLength: buffer.length,
    })
    expect((await sharp(result.data).metadata()).format).toBe('png')
  })

  it('reports geometry alongside the image', async () => {
    const mesh = sphere(5, 16, 12)
    const buffer = toBinaryStl(mesh)
    const result = await renderThumbnail('stl', streamOf(buffer), {
      size: 64,
      byteLength: buffer.length,
    })

    expect(result.stats.triangleCount).toBe(mesh.triangleCount)
    expect(result.stats.bbox!.maxX).toBeCloseTo(5, 1)
  })

  it('renders from ASCII STL, OBJ and 3MF too', async () => {
    const ascii = toAsciiStl(cube(10))
    expect((await renderThumbnail('stl', streamOf(ascii), { size: 48, byteLength: ascii.length })).data.length)
      .toBeGreaterThan(0)

    const obj = toObj(cube(10))
    expect((await renderThumbnail('obj', streamOf(obj), { size: 48 })).data.length).toBeGreaterThan(0)

    const threemf = Buffer.from(toThreeMf(cube(10)))
    const result = await renderThumbnail('3mf', streamOf(threemf), { size: 48 })
    expect(result.embedded).toBe(false)
    expect(result.stats.triangleCount).toBe(12)
  })

  /*
   * A slicer-exported 3MF carries a real plate render. Using it is faster and
   * better looking than anything rasterised from the geometry.
   */
  it('prefers an embedded 3MF thumbnail over rendering', async () => {
    // A real PNG, so sharp can actually decode it.
    const png = await sharp({
      create: { width: 32, height: 32, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } },
    })
      .png()
      .toBuffer()

    const packaged = Buffer.from(
      toThreeMf(cube(10), { thumbnail: { path: 'Metadata/plate_1.png', data: png } }),
    )
    const result = await renderThumbnail('3mf', streamOf(packaged), { size: 64 })

    expect(result.embedded).toBe(true)
    // Geometry is still parsed, because dimensions are wanted regardless.
    expect(result.stats.triangleCount).toBe(12)
  })

  it('falls back to rendering when the embedded image is corrupt', async () => {
    const packaged = Buffer.from(
      toThreeMf(cube(10), { thumbnail: { path: 'Metadata/thumbnail.png', data: fakePng(9) } }),
    )
    const result = await renderThumbnail('3mf', streamOf(packaged), { size: 64 })
    // A broken embedded image must not fail the whole thumbnail.
    expect(result.embedded).toBe(false)
    expect(result.data.length).toBeGreaterThan(0)
  })
})

describe('supportedFormat', () => {
  it('recognises the formats we can parse', () => {
    expect(supportedFormat('stl')).toBe('stl')
    expect(supportedFormat('.STL')).toBe('stl')
    expect(supportedFormat('3mf')).toBe('3mf')
    expect(supportedFormat('obj')).toBe('obj')
    expect(supportedFormat('ply')).toBe('ply')
  })

  it('rejects formats we deliberately do not render', () => {
    // Stored and downloadable, but no CAD kernel is being dragged in for them.
    expect(supportedFormat('step')).toBeNull()
    expect(supportedFormat('fbx')).toBeNull()
    expect(supportedFormat('png')).toBeNull()
  })
})
