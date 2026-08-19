import type { Readable } from 'node:stream'

/**
 * Mesh parsing contracts.
 *
 * Everything here is streaming by design. A print library routinely contains
 * multi-gigabyte STLs, and the whole reason we can render thumbnails without a
 * GPU or a headless browser is that a z-buffer rasteriser never needs the mesh
 * in memory — it only needs one triangle at a time.
 *
 * So parsers do not return a mesh. They walk one, handing each triangle to a
 * visitor, and can be walked twice: once to measure, once to draw.
 */

/**
 * Nine floats: ax, ay, az, bx, by, bz, cx, cy, cz.
 *
 * The SAME array is reused for every triangle. Copy it if you need to keep it.
 * Allocating a fresh object per triangle would dominate the cost — a 6 GB STL
 * is ~120 million triangles.
 */
export type TriangleVisitor = (triangle: Float32Array) => void

/** Opens a fresh stream over the same bytes. Parsers may need two passes. */
export type StreamSource = () => Readable | Promise<Readable>

export interface BoundingBox {
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}

export interface MeshStats {
  triangleCount: number
  bbox: BoundingBox | null
  /** Triangles skipped for being degenerate or containing NaN/Infinity. */
  degenerateCount: number
  format: MeshFormat
  /** Set when the source declares its units (3MF does; STL does not). */
  unit?: string
  /**
   * The file declared more triangles than it actually contained, or fewer.
   * Usually a truncated download. A partial mesh still makes a usable
   * thumbnail, so this is reported rather than thrown.
   */
  truncated?: boolean
}

export type MeshFormat = 'stl' | '3mf' | 'obj' | 'ply'

export class MeshParseError extends Error {
  readonly format: MeshFormat | 'unknown'
  constructor(message: string, format: MeshFormat | 'unknown' = 'unknown') {
    super(message)
    this.name = 'MeshParseError'
    this.format = format
  }
}

export const EMPTY_BBOX: BoundingBox = {
  minX: Infinity,
  minY: Infinity,
  minZ: Infinity,
  maxX: -Infinity,
  maxY: -Infinity,
  maxZ: -Infinity,
}

export function newBox(): BoundingBox {
  return { ...EMPTY_BBOX }
}

/** Grows a box to include a point. */
export function expand(box: BoundingBox, x: number, y: number, z: number): void {
  if (x < box.minX) box.minX = x
  if (y < box.minY) box.minY = y
  if (z < box.minZ) box.minZ = z
  if (x > box.maxX) box.maxX = x
  if (y > box.maxY) box.maxY = y
  if (z > box.maxZ) box.maxZ = z
}

export function isEmptyBox(box: BoundingBox): boolean {
  return !Number.isFinite(box.minX) || !Number.isFinite(box.maxX)
}

export function boxSize(box: BoundingBox): { x: number; y: number; z: number } {
  if (isEmptyBox(box)) return { x: 0, y: 0, z: 0 }
  return {
    x: box.maxX - box.minX,
    y: box.maxY - box.minY,
    z: box.maxZ - box.minZ,
  }
}

/**
 * True when a triangle cannot contribute to a render.
 *
 * Real-world meshes are full of these — exporters emit zero-area slivers and
 * the occasional NaN. They must be skipped rather than allowed to poison the
 * bounding box, which is how one bad triangle makes an entire model render as
 * a dot in the corner.
 */
export function isDegenerate(t: Float32Array): boolean {
  for (let i = 0; i < 9; i++) {
    if (!Number.isFinite(t[i]!)) return true
  }
  // Zero area, via the cross product of two edges.
  const abx = t[3]! - t[0]!
  const aby = t[4]! - t[1]!
  const abz = t[5]! - t[2]!
  const acx = t[6]! - t[0]!
  const acy = t[7]! - t[1]!
  const acz = t[8]! - t[2]!
  const cx = aby * acz - abz * acy
  const cy = abz * acx - abx * acz
  const cz = abx * acy - aby * acx
  return cx * cx + cy * cy + cz * cz === 0
}
