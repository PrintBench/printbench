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
 * PLY reader, ASCII and binary little-endian.
 *
 * PLY is what most 3D scanners and photogrammetry tools emit, so files are
 * often large and vertex-heavy. Like OBJ it is indexed, so the vertex table is
 * accumulated while faces stream.
 *
 * Big-endian PLY exists but is vanishingly rare in a print library; it is
 * detected and refused explicitly rather than silently misread as little-endian,
 * which would produce nonsense geometry.
 */

export interface PlyOptions {
  signal?: AbortSignal
  maxVertices?: number
}

const DEFAULT_MAX_VERTICES = 20_000_000

interface PlyProperty {
  name: string
  type: string
  /** Set for `property list`, e.g. face vertex_indices. */
  countType?: string
}

interface PlyElement {
  name: string
  count: number
  properties: PlyProperty[]
}

interface PlyHeader {
  format: 'ascii' | 'binary_little_endian'
  elements: PlyElement[]
  headerLength: number
}

const SCALAR_SIZE: Record<string, number> = {
  char: 1,
  uchar: 1,
  int8: 1,
  uint8: 1,
  short: 2,
  ushort: 2,
  int16: 2,
  uint16: 2,
  int: 4,
  uint: 4,
  int32: 4,
  uint32: 4,
  float: 4,
  float32: 4,
  double: 8,
  float64: 8,
}

export function parsePlyHeader(buffer: Buffer): PlyHeader {
  const text = buffer.subarray(0, Math.min(buffer.length, 64 * 1024)).toString('latin1')
  const end = text.indexOf('end_header')
  if (end === -1) throw new MeshParseError('PLY header is missing end_header', 'ply')

  const headerText = text.slice(0, end)
  const afterEnd = text.indexOf('\n', end)
  const headerLength = afterEnd === -1 ? end + 'end_header'.length : afterEnd + 1

  if (!/^ply\s/.test(text)) throw new MeshParseError('Not a PLY file', 'ply')

  const formatLine = headerText.match(/format\s+(\S+)/)
  const rawFormat = formatLine?.[1]
  if (rawFormat === 'binary_big_endian') {
    throw new MeshParseError('Big-endian PLY is not supported', 'ply')
  }
  if (rawFormat !== 'ascii' && rawFormat !== 'binary_little_endian') {
    throw new MeshParseError(`Unknown PLY format: ${rawFormat}`, 'ply')
  }

  const elements: PlyElement[] = []
  for (const line of headerText.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts[0] === 'element') {
      elements.push({ name: parts[1] ?? '', count: Number(parts[2] ?? 0), properties: [] })
    } else if (parts[0] === 'property' && elements.length > 0) {
      const current = elements[elements.length - 1]!
      if (parts[1] === 'list') {
        current.properties.push({ name: parts[4] ?? '', type: parts[3] ?? '', countType: parts[2] })
      } else {
        current.properties.push({ name: parts[2] ?? '', type: parts[1] ?? '' })
      }
    }
  }

  return { format: rawFormat, elements, headerLength }
}

export async function readPly(
  source: StreamSource,
  visit: TriangleVisitor,
  options: PlyOptions = {},
): Promise<MeshStats> {
  const whole = await readAll(source)
  const header = parsePlyHeader(whole)

  const vertexElement = header.elements.find((e) => e.name === 'vertex')
  const faceElement = header.elements.find((e) => e.name === 'face')
  if (!vertexElement) throw new MeshParseError('PLY has no vertex element', 'ply')

  const maxVertices = options.maxVertices ?? DEFAULT_MAX_VERTICES
  if (vertexElement.count > maxVertices) {
    throw new MeshParseError(`PLY exceeds ${maxVertices} vertices`, 'ply')
  }

  const stats: MeshStats = {
    triangleCount: 0,
    bbox: newBox(),
    degenerateCount: 0,
    format: 'ply',
  }
  const triangle = new Float32Array(9)
  const vertices = new Float32Array(vertexElement.count * 3)

  const emit = (a: number, b: number, c: number): void => {
    if (a < 0 || b < 0 || c < 0) return
    if (a >= vertexElement.count || b >= vertexElement.count || c >= vertexElement.count) return
    triangle[0] = vertices[a * 3]!
    triangle[1] = vertices[a * 3 + 1]!
    triangle[2] = vertices[a * 3 + 2]!
    triangle[3] = vertices[b * 3]!
    triangle[4] = vertices[b * 3 + 1]!
    triangle[5] = vertices[b * 3 + 2]!
    triangle[6] = vertices[c * 3]!
    triangle[7] = vertices[c * 3 + 1]!
    triangle[8] = vertices[c * 3 + 2]!

    if (isDegenerate(triangle)) {
      stats.degenerateCount++
      return
    }
    const box = stats.bbox!
    expand(box, triangle[0]!, triangle[1]!, triangle[2]!)
    expand(box, triangle[3]!, triangle[4]!, triangle[5]!)
    expand(box, triangle[6]!, triangle[7]!, triangle[8]!)
    stats.triangleCount++
    visit(triangle)
  }

  if (header.format === 'ascii') {
    readAsciiBody(whole, header, vertexElement, faceElement, vertices, emit)
  } else {
    readBinaryBody(whole, header, vertexElement, faceElement, vertices, emit)
  }

  if (stats.triangleCount === 0) {
    stats.bbox = null
    if (stats.degenerateCount === 0) {
      throw new MeshParseError('PLY contains no faces', 'ply')
    }
  }
  return stats
}

function readAsciiBody(
  buffer: Buffer,
  header: PlyHeader,
  vertexElement: PlyElement,
  faceElement: PlyElement | undefined,
  vertices: Float32Array,
  emit: (a: number, b: number, c: number) => void,
): void {
  const body = buffer.subarray(header.headerLength).toString('latin1')
  const lines = body.split(/\r?\n/).filter((line) => line.trim().length > 0)

  const xIndex = vertexElement.properties.findIndex((p) => p.name === 'x')
  let cursor = 0

  for (let i = 0; i < vertexElement.count && cursor < lines.length; i++, cursor++) {
    const parts = lines[cursor]!.trim().split(/\s+/)
    vertices[i * 3] = Number.parseFloat(parts[xIndex] ?? '0')
    vertices[i * 3 + 1] = Number.parseFloat(parts[xIndex + 1] ?? '0')
    vertices[i * 3 + 2] = Number.parseFloat(parts[xIndex + 2] ?? '0')
  }

  if (!faceElement) return
  for (let i = 0; i < faceElement.count && cursor < lines.length; i++, cursor++) {
    const parts = lines[cursor]!.trim().split(/\s+/)
    const count = Number.parseInt(parts[0] ?? '0', 10)
    // Fan-triangulate: quads are common in PLY too.
    for (let k = 1; k + 2 <= count; k++) {
      emit(
        Number.parseInt(parts[1]!, 10),
        Number.parseInt(parts[k + 1]!, 10),
        Number.parseInt(parts[k + 2]!, 10),
      )
    }
  }
}

function readBinaryBody(
  buffer: Buffer,
  header: PlyHeader,
  vertexElement: PlyElement,
  faceElement: PlyElement | undefined,
  vertices: Float32Array,
  emit: (a: number, b: number, c: number) => void,
): void {
  let offset = header.headerLength

  const readScalar = (type: string): number => {
    const size = SCALAR_SIZE[type] ?? 4
    // No initialiser: the switch has a default, so every path assigns, and the
    // compiler checks that rather than a placeholder hiding a missed branch.
    let value: number
    switch (type) {
      case 'char':
      case 'int8':
        value = buffer.readInt8(offset)
        break
      case 'uchar':
      case 'uint8':
        value = buffer.readUInt8(offset)
        break
      case 'short':
      case 'int16':
        value = buffer.readInt16LE(offset)
        break
      case 'ushort':
      case 'uint16':
        value = buffer.readUInt16LE(offset)
        break
      case 'int':
      case 'int32':
        value = buffer.readInt32LE(offset)
        break
      case 'uint':
      case 'uint32':
        value = buffer.readUInt32LE(offset)
        break
      case 'double':
      case 'float64':
        value = buffer.readDoubleLE(offset)
        break
      default:
        value = buffer.readFloatLE(offset)
    }
    offset += size
    return value
  }

  const xIndex = vertexElement.properties.findIndex((p) => p.name === 'x')

  for (let i = 0; i < vertexElement.count; i++) {
    for (let p = 0; p < vertexElement.properties.length; p++) {
      const property = vertexElement.properties[p]!
      const value = readScalar(property.type)
      // Read every property to keep the offset correct, but keep only x, y, z —
      // scanner output is full of colour, normal and confidence channels.
      if (p >= xIndex && p < xIndex + 3) vertices[i * 3 + (p - xIndex)] = value
    }
  }

  if (!faceElement) return
  for (let i = 0; i < faceElement.count && offset < buffer.length; i++) {
    for (const property of faceElement.properties) {
      if (property.countType) {
        const count = readScalar(property.countType)
        const indices: number[] = []
        for (let k = 0; k < count; k++) indices.push(readScalar(property.type))
        for (let k = 1; k + 1 < indices.length; k++) {
          emit(indices[0]!, indices[k]!, indices[k + 1]!)
        }
      } else {
        readScalar(property.type)
      }
    }
  }
}

async function readAll(source: StreamSource): Promise<Buffer> {
  const stream = await source()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}
