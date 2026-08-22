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
 * STL reader, binary and ASCII.
 *
 * Streaming: bytes are consumed a chunk at a time and each triangle is handed
 * straight to the visitor. Memory stays flat regardless of file size.
 */

const BINARY_HEADER = 80
const BINARY_COUNT = 4
const BINARY_TRIANGLE = 50 // 12 float32 (normal + 3 vertices) + 2 byte attribute

export interface StlOptions {
  /** Total byte length, when known. Makes format detection exact. */
  byteLength?: number
  signal?: AbortSignal
}

/**
 * Decides whether an STL is binary or ASCII.
 *
 * The common shortcut — "starts with the word solid, therefore ASCII" — is
 * WRONG and produces garbage on a large fraction of real files: plenty of
 * exporters write "solid" into the 80-byte binary header. SolidWorks and
 * Magics both do.
 *
 * The reliable test is arithmetic. A binary STL is exactly
 * 84 + 50 x triangleCount bytes, so read the declared count and check whether
 * the length agrees. Only fall back to sniffing text when the length is
 * unknown.
 */
export function detectStlFormat(head: Buffer, byteLength?: number): 'binary' | 'ascii' {
  if (head.length < BINARY_HEADER + BINARY_COUNT) {
    // Too short to be a binary STL with any triangles at all.
    return 'ascii'
  }

  if (byteLength !== undefined) {
    const declared = head.readUInt32LE(BINARY_HEADER)
    const expected = BINARY_HEADER + BINARY_COUNT + declared * BINARY_TRIANGLE
    if (expected === byteLength) return 'binary'
    // Some writers pad the end; accept a small tail but not a wild mismatch.
    if (declared > 0 && byteLength > expected && byteLength - expected <= 2) return 'binary'
  }

  // No length available: sniff. A real ASCII STL has "facet normal" early on.
  const text = head.subarray(0, Math.min(head.length, 2048)).toString('latin1')
  if (/^\s*solid/i.test(text) && /facet\s+normal/i.test(text)) return 'ascii'
  return byteLength === undefined && /^\s*solid/i.test(text) ? 'ascii' : 'binary'
}

export async function readStl(
  source: StreamSource,
  visit: TriangleVisitor,
  options: StlOptions = {},
): Promise<MeshStats> {
  const head = await readHead(source, BINARY_HEADER + BINARY_COUNT + 16)
  const format = detectStlFormat(head, options.byteLength)
  return format === 'binary'
    ? readBinaryStl(source, visit, options)
    : readAsciiStl(source, visit, options)
}

async function readHead(source: StreamSource, bytes: number): Promise<Buffer> {
  const stream = await source()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer)
      total += (chunk as Buffer).length
      if (total >= bytes) break
    }
  } finally {
    stream.destroy()
  }
  return Buffer.concat(chunks).subarray(0, bytes)
}

async function readBinaryStl(
  source: StreamSource,
  visit: TriangleVisitor,
  options: StlOptions,
): Promise<MeshStats> {
  const stats: MeshStats = {
    triangleCount: 0,
    bbox: newBox(),
    degenerateCount: 0,
    format: 'stl',
  }

  const triangle = new Float32Array(9)
  const stream = await source()

  // Carry holds the partial triangle left over between chunks. Chunk sizes are
  // arbitrary and never align to the 50-byte record.
  // Annotated because subarray() widens the buffer's backing-store type.
  let carry: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let headerConsumed = 0
  let declared = -1

  try {
    for await (const raw of stream) {
      options.signal?.throwIfAborted()
      let chunk = raw as Buffer

      // Skip the 84-byte header across however many chunks it spans.
      if (headerConsumed < BINARY_HEADER + BINARY_COUNT) {
        const need = BINARY_HEADER + BINARY_COUNT - headerConsumed
        if (chunk.length < need) {
          carry = Buffer.concat([carry, chunk])
          headerConsumed += chunk.length
          continue
        }
        const header = Buffer.concat([carry, chunk.subarray(0, need)])
        declared = header.readUInt32LE(BINARY_HEADER)
        chunk = chunk.subarray(need)
        headerConsumed = BINARY_HEADER + BINARY_COUNT
        carry = Buffer.alloc(0)
      }

      const buffer = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk
      const whole = Math.floor(buffer.length / BINARY_TRIANGLE)

      for (let i = 0; i < whole; i++) {
        const offset = i * BINARY_TRIANGLE
        // Bytes 0-11 are the stored normal, which is routinely wrong or zero.
        // We recompute normals from the winding, so it is skipped entirely.
        for (let v = 0; v < 9; v++) {
          triangle[v] = buffer.readFloatLE(offset + 12 + v * 4)
        }
        emit(triangle, stats, visit)
      }

      carry = buffer.subarray(whole * BINARY_TRIANGLE)
    }
  } finally {
    stream.destroy()
  }

  if (declared >= 0 && stats.triangleCount + stats.degenerateCount !== declared) {
    // Truncated or padded. Worth surfacing rather than silently rendering half
    // a model, but not fatal — a partial mesh still makes a useful thumbnail.
    stats.truncated = true
  }

  return finish(stats)
}

async function readAsciiStl(
  source: StreamSource,
  visit: TriangleVisitor,
  options: StlOptions,
): Promise<MeshStats> {
  const stats: MeshStats = {
    triangleCount: 0,
    bbox: newBox(),
    degenerateCount: 0,
    format: 'stl',
  }

  const triangle = new Float32Array(9)
  let vertexIndex = 0
  let tail = ''

  const stream = await source()
  try {
    for await (const raw of stream) {
      options.signal?.throwIfAborted()
      const text = tail + (raw as Buffer).toString('latin1')
      const lines = text.split('\n')
      // The final fragment may be an incomplete line; hold it for the next chunk.
      tail = lines.pop() ?? ''

      for (const line of lines) {
        vertexIndex = consumeAsciiLine(line, triangle, vertexIndex, stats, visit)
      }
    }
    if (tail) consumeAsciiLine(tail, triangle, vertexIndex, stats, visit)
  } finally {
    stream.destroy()
  }

  return finish(stats)
}

function consumeAsciiLine(
  line: string,
  triangle: Float32Array,
  vertexIndex: number,
  stats: MeshStats,
  visit: TriangleVisitor,
): number {
  const trimmed = line.trim()
  if (!trimmed.startsWith('vertex') && !trimmed.startsWith('VERTEX')) return vertexIndex

  const parts = trimmed.split(/\s+/)
  if (parts.length < 4) return vertexIndex

  const base = vertexIndex * 3
  triangle[base] = Number.parseFloat(parts[1]!)
  triangle[base + 1] = Number.parseFloat(parts[2]!)
  triangle[base + 2] = Number.parseFloat(parts[3]!)

  const next = vertexIndex + 1
  if (next === 3) {
    emit(triangle, stats, visit)
    return 0
  }
  return next
}

function emit(triangle: Float32Array, stats: MeshStats, visit: TriangleVisitor): void {
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

function finish(stats: MeshStats): MeshStats {
  if (stats.triangleCount === 0) {
    stats.bbox = null
    if (stats.degenerateCount === 0) {
      throw new MeshParseError('No triangles found in STL', 'stl')
    }
  }
  return stats
}
