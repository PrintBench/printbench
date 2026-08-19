import {
  MeshParseError,
  expand,
  isDegenerate,
  newBox,
  type MeshStats,
  type StreamSource,
  type TriangleVisitor,
} from '../types'

/**
 * Wavefront OBJ reader.
 *
 * OBJ is indexed and text-based, so unlike STL it cannot be fully streamed:
 * faces reference vertices by index and may refer backwards to any earlier
 * vertex. The vertex table is therefore accumulated, but faces are emitted as
 * they are read, so only the vertices are held — roughly a third of the memory
 * a full mesh would take.
 *
 * OBJ is a stored, downloadable format here rather than a primary one; the
 * effort goes into not falling over on the variants that exist in the wild.
 */

export interface ObjOptions {
  signal?: AbortSignal
  /** Guard against a malicious or corrupt file exhausting the heap. */
  maxVertices?: number
}

const DEFAULT_MAX_VERTICES = 20_000_000

export async function readObj(
  source: StreamSource,
  visit: TriangleVisitor,
  options: ObjOptions = {},
): Promise<MeshStats> {
  const maxVertices = options.maxVertices ?? DEFAULT_MAX_VERTICES

  const stats: MeshStats = {
    triangleCount: 0,
    bbox: newBox(),
    degenerateCount: 0,
    format: 'obj',
  }

  // Grown geometrically rather than pushed onto an array of arrays: a dense
  // scan has millions of vertices and per-vertex objects would dominate.
  let vertices = new Float32Array(3 * 1024)
  let vertexCount = 0

  const triangle = new Float32Array(9)
  let tail = ''

  const addVertex = (x: number, y: number, z: number): void => {
    if (vertexCount >= maxVertices) {
      throw new MeshParseError(`OBJ exceeds ${maxVertices} vertices`, 'obj')
    }
    if ((vertexCount + 1) * 3 > vertices.length) {
      const grown = new Float32Array(vertices.length * 2)
      grown.set(vertices)
      vertices = grown
    }
    vertices[vertexCount * 3] = x
    vertices[vertexCount * 3 + 1] = y
    vertices[vertexCount * 3 + 2] = z
    vertexCount++
  }

  const readIndex = (token: string): number => {
    // Faces are "v", "v/vt", "v//vn" or "v/vt/vn"; only the position matters.
    const slash = token.indexOf('/')
    const raw = Number.parseInt(slash === -1 ? token : token.slice(0, slash), 10)
    if (!Number.isInteger(raw) || raw === 0) return -1
    // OBJ is 1-based, and negative indices count back from the current end.
    return raw > 0 ? raw - 1 : vertexCount + raw
  }

  const writeVertex = (slot: number, index: number): boolean => {
    if (index < 0 || index >= vertexCount) return false
    triangle[slot * 3] = vertices[index * 3]!
    triangle[slot * 3 + 1] = vertices[index * 3 + 1]!
    triangle[slot * 3 + 2] = vertices[index * 3 + 2]!
    return true
  }

  const handleLine = (line: string): void => {
    // Comments and the many directives we do not care about (vt, vn, usemtl,
    // mtllib, o, g, s) are skipped by only matching what we need.
    if (line.length === 0) return
    const code = line.charCodeAt(0)
    if (code !== 118 /* v */ && code !== 102 /* f */) return

    const parts = line.trim().split(/\s+/)
    const keyword = parts[0]

    if (keyword === 'v') {
      if (parts.length < 4) return
      addVertex(
        Number.parseFloat(parts[1]!),
        Number.parseFloat(parts[2]!),
        Number.parseFloat(parts[3]!),
      )
      return
    }

    if (keyword !== 'f' || parts.length < 4) return

    /*
     * Fan-triangulate. OBJ faces may be quads or arbitrary n-gons, and a mesh
     * that renders as nothing because only triangles were handled is a common
     * failure — quads are extremely common in OBJ exports.
     */
    const first = readIndex(parts[1]!)
    for (let i = 2; i < parts.length - 1; i++) {
      const second = readIndex(parts[i]!)
      const third = readIndex(parts[i + 1]!)
      if (!writeVertex(0, first) || !writeVertex(1, second) || !writeVertex(2, third)) continue

      if (isDegenerate(triangle)) {
        stats.degenerateCount++
        continue
      }
      const box = stats.bbox!
      expand(box, triangle[0]!, triangle[1]!, triangle[2]!)
      expand(box, triangle[3]!, triangle[4]!, triangle[5]!)
      expand(box, triangle[6]!, triangle[7]!, triangle[8]!)
      stats.triangleCount++
      visit(triangle)
    }
  }

  const stream = await source()
  try {
    for await (const raw of stream) {
      options.signal?.throwIfAborted()
      const text = tail + (raw as Buffer).toString('utf8')
      const lines = text.split('\n')
      tail = lines.pop() ?? ''
      for (const line of lines) handleLine(line)
    }
    if (tail) handleLine(tail)
  } finally {
    stream.destroy()
  }

  if (stats.triangleCount === 0) {
    stats.bbox = null
    if (stats.degenerateCount === 0) {
      throw new MeshParseError('OBJ contains no faces', 'obj')
    }
  }

  return stats
}
