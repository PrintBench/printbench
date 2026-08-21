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
 * The largest dimension, in millimetres, a real model can plausibly have.
 *
 * A kilometre: a thousand times the largest printable object, so no genuine
 * model is ever near it. The threshold does not exist to police model size —
 * it exists to recognise a file that is not a mesh at all.
 *
 * Random bytes read as a binary STL decode into coordinates near ±3.4e38,
 * the edge of the Float32 range. Each one is individually finite, so
 * `isDegenerate` passes them happily, and the result is a bounding box some
 * 6.8e38 across. That is not a large model; it is proof the bytes were never
 * geometry.
 */
export const MAX_PLAUSIBLE_DIMENSION = 1_000_000

/**
 * True when a bounding box is too large to have come from a real mesh.
 *
 * Tested on the box's SIZE rather than its coordinates: a mesh may sit
 * legitimately far from the origin — exported from a build plate, say — and
 * it is the extent that has to be believable, not the position.
 *
 * An absent or empty box is NOT implausible, merely empty. That is a
 * different failure with its own message, and conflating the two would
 * report "not a mesh" for a file that simply has no triangles.
 */
export function isImplausiblySized(box: BoundingBox | null): box is BoundingBox {
  if (!box || isEmptyBox(box)) return false
  const size = boxSize(box)
  return (
    size.x > MAX_PLAUSIBLE_DIMENSION ||
    size.y > MAX_PLAUSIBLE_DIMENSION ||
    size.z > MAX_PLAUSIBLE_DIMENSION
  )
}

/** Explains an implausible box in terms someone can act on. */
export function describeImplausibleSize(box: BoundingBox): string {
  const size = boxSize(box)
  const largest = Math.max(size.x, size.y, size.z)
  return (
    `This does not look like a mesh: its geometry spans ${largest.toPrecision(3)} mm, ` +
    `which is not a real object. The file is probably corrupt, truncated, or not ` +
    `the format its extension claims.`
  )
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
