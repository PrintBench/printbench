import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { RENDERER_VERSION, Rasterizer } from './rasterizer'
import { newBox, type BoundingBox } from '../types'
import { cube, plate, sphere, torus, type Mesh } from '../__fixtures__/shapes'

/**
 * Golden-image tests.
 *
 * The rasteriser is deterministic — no GPU, no driver, no threading — so its
 * output can be hashed and pinned. This catches unintended visual regressions
 * that the structural tests would sail past: a sign flip in the lighting, a
 * half-pixel sampling shift, a change to the sRGB curve.
 *
 * These hashes are EXPECTED to change when the rendering is deliberately
 * altered. When that happens:
 *
 *   1. Render the fixtures and look at them, rather than trusting the numbers.
 *   2. Update the hashes below.
 *   3. Bump RENDERER_VERSION, so every cached thumbnail is regenerated.
 *
 * Step 3 is the one that matters in production: the version is part of the
 * thumbnail cache key, so without it users keep seeing stale renders.
 */
const GOLDEN: Record<string, string> = {
  cube: '6260c2114c0f0fc7',
  sphere: 'd3aeea4158067734',
  torus: '3fce3005c5744cf1',
  plate: '15c1b70fc0fc0298',
}

/** Pinned so a change to the fixtures cannot silently invalidate the hashes. */
const GOLDEN_RENDERER_VERSION = 2

function boxOf(mesh: Mesh): BoundingBox {
  const box = newBox()
  for (let i = 0; i < mesh.triangleCount * 3; i++) {
    const x = mesh.triangles[i * 3]!
    const y = mesh.triangles[i * 3 + 1]!
    const z = mesh.triangles[i * 3 + 2]!
    box.minX = Math.min(box.minX, x)
    box.maxX = Math.max(box.maxX, x)
    box.minY = Math.min(box.minY, y)
    box.maxY = Math.max(box.maxY, y)
    box.minZ = Math.min(box.minZ, z)
    box.maxZ = Math.max(box.maxZ, z)
  }
  return box
}

function fingerprint(mesh: Mesh): string {
  const rasterizer = new Rasterizer(boxOf(mesh), { size: 64, supersample: 2 })
  const triangle = new Float32Array(9)
  for (let i = 0; i < mesh.triangleCount; i++) {
    triangle.set(mesh.triangles.subarray(i * 9, i * 9 + 9))
    rasterizer.addTriangle(triangle)
  }
  return createHash('sha256')
    .update(Buffer.from(rasterizer.finish().pixels))
    .digest('hex')
    .slice(0, 16)
}

describe('golden renders', () => {
  it('RENDERER_VERSION matches the version these hashes were taken at', () => {
    // If this fails, the hashes below are stale and must be regenerated.
    expect(RENDERER_VERSION).toBe(GOLDEN_RENDERER_VERSION)
  })

  const shapes: Record<string, () => Mesh> = {
    cube: () => cube(10),
    sphere: () => sphere(5, 24, 16),
    torus: () => torus(6, 2, 24, 12),
    plate: () => plate(20),
  }

  for (const [name, make] of Object.entries(shapes)) {
    it(`renders ${name} identically to the pinned image`, () => {
      expect(fingerprint(make())).toBe(GOLDEN[name])
    })
  }

  it('produces the same bytes on every run', () => {
    expect(fingerprint(torus(6, 2, 24, 12))).toBe(fingerprint(torus(6, 2, 24, 12)))
  })
})
