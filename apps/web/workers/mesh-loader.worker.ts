/// <reference lib="webworker" />

import { BufferGeometry, Float32BufferAttribute, type Object3D } from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { readThreeMf } from '@pb/mesh/parse'

/**
 * Downloads and parses a mesh, off the main thread.
 *
 * Parsing is the part that blocks: a 200 MB STL takes seconds and would freeze
 * the page mid-scroll. Rendering is GPU work and stays on the main thread,
 * which keeps OrbitControls straightforward — driving controls from inside a
 * worker means proxying every pointer event across the boundary, a lot of
 * machinery for something that is not the bottleneck.
 *
 * Parsed positions come back as a transferable Float32Array, so the buffer is
 * moved rather than copied.
 */

export type MeshFormat = 'stl' | '3mf' | 'obj' | 'ply'

export type MeshLoadRequest = {
  type: 'load'
  url: string
  format: MeshFormat
}

export type MeshLoadResponse =
  | { type: 'progress'; loaded: number; total: number }
  | {
      type: 'loaded'
      positions: Float32Array
      triangleCount: number
      bounds: { min: [number, number, number]; max: [number, number, number] }
    }
  | { type: 'error'; message: string }

const scope = self as unknown as DedicatedWorkerGlobalScope

scope.addEventListener('message', (event: MessageEvent<MeshLoadRequest>) => {
  if (event.data?.type !== 'load') return
  void load(event.data)
})

async function load(request: MeshLoadRequest): Promise<void> {
  try {
    const buffer = await download(request.url)
    const positions = parse(buffer, request.format)

    if (positions.length === 0) throw new Error('This file contains no geometry')

    let minX = Infinity, minY = Infinity, minZ = Infinity
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i]!, y = positions[i + 1]!, z = positions[i + 2]!
      // Skip non-finite values rather than letting one bad vertex collapse the
      // whole bounding box, which would frame the model as a dot.
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (z < minZ) minZ = z
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      if (z > maxZ) maxZ = z
    }

    const message: MeshLoadResponse = {
      type: 'loaded',
      positions,
      triangleCount: Math.floor(positions.length / 9),
      bounds: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    }

    // Transfer rather than copy: a large mesh is tens of megabytes.
    scope.postMessage(message, [positions.buffer])
  } catch (error) {
    scope.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    } satisfies MeshLoadResponse)
  }
}

/** Streams the body so progress can be reported on a slow connection. */
async function download(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`Could not load the file (HTTP ${response.status})`)

  const total = Number(response.headers.get('content-length') ?? 0)
  if (!response.body || total === 0) return response.arrayBuffer()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.length
    scope.postMessage({ type: 'progress', loaded, total } satisfies MeshLoadResponse)
  }

  const merged = new Uint8Array(loaded)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged.buffer
}

function parse(buffer: ArrayBuffer, format: MeshFormat): Float32Array {
  switch (format) {
    case 'stl':
      return flatten(new STLLoader().parse(buffer))
    case 'ply':
      return flatten(new PLYLoader().parse(buffer))
    case 'obj':
      return mergeScene(new OBJLoader().parse(new TextDecoder().decode(buffer)))
    case '3mf':
      return readThreeMfGeometry(buffer)
  }
}

/**
 * Parses 3MF with our own reader rather than three's ThreeMFLoader.
 *
 * ThreeMFLoader uses DOMParser, which does not exist in a Web Worker — it fails
 * with "DOMParser is not defined". Our reader uses fast-xml-parser and fflate,
 * both of which run anywhere, so the same code that produces the thumbnail also
 * produces the interactive view. One parser, one behaviour.
 */
function readThreeMfGeometry(buffer: ArrayBuffer): Float32Array {
  const chunks: Float32Array[] = []
  let count = 0
  readThreeMf(new Uint8Array(buffer), (triangle) => {
    // The visitor reuses one array, so copy before keeping it.
    chunks.push(Float32Array.from(triangle))
    count++
  })
  if (count === 0) throw new Error('No geometry in this 3MF')

  const merged = new Float32Array(count * 9)
  for (let i = 0; i < chunks.length; i++) merged.set(chunks[i]!, i * 9)
  return merged
}

/**
 * Merges every mesh in a scene graph into one triangle list.
 *
 * OBJ and 3MF return a graph rather than a single geometry, and each object
 * carries its own transform. A 3MF build plate positions its objects by matrix,
 * so ignoring those stacks everything at the origin — the model looks like one
 * jumbled lump instead of a laid-out plate.
 */
function mergeScene(root: Object3D): Float32Array {
  const parts: Float32Array[] = []
  root.updateMatrixWorld(true)

  root.traverse((child) => {
    const geometry = (child as { geometry?: BufferGeometry }).geometry
    if (!geometry || typeof geometry.getAttribute !== 'function') return
    if (!geometry.getAttribute('position')) return

    const flat = flatten(geometry)
    const m = child.matrixWorld.elements
    const transformed = new Float32Array(flat.length)

    for (let i = 0; i < flat.length; i += 3) {
      const x = flat[i]!, y = flat[i + 1]!, z = flat[i + 2]!
      transformed[i] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!
      transformed[i + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!
      transformed[i + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!
    }
    parts.push(transformed)
  })

  if (parts.length === 0) throw new Error('No mesh found in this file')
  if (parts.length === 1) return parts[0]!

  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const merged = new Float32Array(total)
  let offset = 0
  for (const part of parts) {
    merged.set(part, offset)
    offset += part.length
  }
  return merged
}

/** Resolves an index buffer into a flat triangle list. */
function flatten(geometry: BufferGeometry): Float32Array {
  const attribute = geometry.getAttribute('position')
  if (!attribute) return new Float32Array(0)

  const source = attribute.array as ArrayLike<number>
  const index = geometry.getIndex()
  if (!index) return new Float32Array(source as ArrayLike<number>)

  const out = new Float32Array(index.count * 3)
  for (let i = 0; i < index.count; i++) {
    const from = index.getX(i) * 3
    out[i * 3] = source[from]!
    out[i * 3 + 1] = source[from + 1]!
    out[i * 3 + 2] = source[from + 2]!
  }
  return out
}

/** Re-exported so the viewer can build geometry from the transferred buffer. */
export { BufferGeometry, Float32BufferAttribute }
