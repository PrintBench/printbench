import { unzipSync } from 'fflate'
import { XMLParser } from 'fast-xml-parser'
import {
  MeshParseError,
  expand,
  isDegenerate,
  newBox,
  type MeshStats,
  type TriangleVisitor,
} from '../types'

/**
 * Decodes UTF-8 without Buffer.
 *
 * This parser runs in the browser as well as in Node: three's own 3MFLoader
 * uses DOMParser, which does not exist in a Web Worker, so the viewer parses
 * 3MF with this instead. That also means one parser produces both the
 * thumbnail and the interactive view.
 */
const decodeUtf8 = (bytes: Uint8Array): string => new TextDecoder('utf-8').decode(bytes)

/**
 * 3MF reader.
 *
 * A 3MF is an OPC package: a zip containing `3D/3dmodel.model` (XML geometry),
 * relationship files, and often a thumbnail. Unlike STL it is indexed —
 * vertices are declared once and referenced by triangles — and it declares its
 * units, so dimensions are trustworthy.
 *
 * This is the one format where we do NOT stream: the geometry is inside a
 * deflate stream inside a zip, and the vertex table must be resolved before
 * any triangle can be read. In practice 3MF files are small (the format
 * compresses well and is used for finished parts rather than raw scans), so
 * a size ceiling is applied instead.
 */

/** Beyond this the file is refused rather than risking the worker's heap. */
export const MAX_3MF_BYTES = 512 * 1024 * 1024

const MODEL_PATHS = ['3D/3dmodel.model', '3d/3dmodel.model']

/** Millimetres per unit, so every model can be normalised to mm. */
const UNIT_SCALE: Record<string, number> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
}

export interface ThreeMfResult extends MeshStats {
  /** Raw bytes of an embedded thumbnail, when the package carries one. */
  thumbnail?: { data: Uint8Array; contentType: string; path: string }
}

export function readThreeMf(buffer: Uint8Array, visit: TriangleVisitor): ThreeMfResult {
  if (buffer.byteLength > MAX_3MF_BYTES) {
    throw new MeshParseError(
      `3MF is ${Math.round(buffer.byteLength / 1024 / 1024)} MB, over the ${MAX_3MF_BYTES / 1024 / 1024} MB limit`,
      '3mf',
    )
  }

  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(buffer)
  } catch (error) {
    throw new MeshParseError(
      `Not a readable 3MF package: ${error instanceof Error ? error.message : String(error)}`,
      '3mf',
    )
  }

  const modelKey =
    MODEL_PATHS.find((path) => entries[path]) ??
    Object.keys(entries).find((key) => key.toLowerCase().endsWith('3dmodel.model'))

  if (!modelKey || !entries[modelKey]) {
    throw new MeshParseError('3MF package contains no 3dmodel.model', '3mf')
  }

  const stats = parseModelXml(decodeUtf8(entries[modelKey]), visit)
  const thumbnail = findThumbnail(entries)
  return thumbnail ? { ...stats, thumbnail } : stats
}

function parseModelXml(xml: string, visit: TriangleVisitor): MeshStats {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    // Objects with one child must still be arrays, or a single-mesh model and
    // a multi-mesh one take different code paths.
    isArray: (name) => ['object', 'vertex', 'triangle', 'item'].includes(name),
  })

  let doc: Record<string, unknown>
  try {
    doc = parser.parse(xml) as Record<string, unknown>
  } catch (error) {
    throw new MeshParseError(
      `Malformed 3MF XML: ${error instanceof Error ? error.message : String(error)}`,
      '3mf',
    )
  }

  const model = (doc.model ?? doc.Model) as Record<string, unknown> | undefined
  if (!model) throw new MeshParseError('3MF XML has no <model> element', '3mf')

  const unit = String(model['@unit'] ?? 'millimeter').toLowerCase()
  const scale = UNIT_SCALE[unit] ?? 1

  const resources = model.resources as Record<string, unknown> | undefined
  const objects = (resources?.object ?? []) as Record<string, unknown>[]

  const stats: MeshStats = {
    triangleCount: 0,
    bbox: newBox(),
    degenerateCount: 0,
    format: '3mf',
    unit: 'mm',
  }

  const triangle = new Float32Array(9)

  for (const object of objects) {
    const mesh = object.mesh as Record<string, unknown> | undefined
    if (!mesh) continue

    const vertexNodes = ((mesh.vertices as Record<string, unknown>)?.vertex ?? []) as Record<
      string,
      unknown
    >[]
    const triangleNodes = ((mesh.triangles as Record<string, unknown>)?.triangle ?? []) as Record<
      string,
      unknown
    >[]

    // Flat typed array rather than objects: a dense mesh has millions of these.
    const vertices = new Float32Array(vertexNodes.length * 3)
    for (let i = 0; i < vertexNodes.length; i++) {
      const node = vertexNodes[i]!
      vertices[i * 3] = Number(node['@x']) * scale
      vertices[i * 3 + 1] = Number(node['@y']) * scale
      vertices[i * 3 + 2] = Number(node['@z']) * scale
    }

    for (const node of triangleNodes) {
      const v1 = Number(node['@v1'])
      const v2 = Number(node['@v2'])
      const v3 = Number(node['@v3'])

      // A malformed index must be skipped, not read out of bounds.
      if (!isValidIndex(v1, vertexNodes.length)) continue
      if (!isValidIndex(v2, vertexNodes.length)) continue
      if (!isValidIndex(v3, vertexNodes.length)) continue

      triangle[0] = vertices[v1 * 3]!
      triangle[1] = vertices[v1 * 3 + 1]!
      triangle[2] = vertices[v1 * 3 + 2]!
      triangle[3] = vertices[v2 * 3]!
      triangle[4] = vertices[v2 * 3 + 1]!
      triangle[5] = vertices[v2 * 3 + 2]!
      triangle[6] = vertices[v3 * 3]!
      triangle[7] = vertices[v3 * 3 + 1]!
      triangle[8] = vertices[v3 * 3 + 2]!

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

  if (stats.triangleCount === 0) {
    stats.bbox = null
    if (stats.degenerateCount === 0) {
      throw new MeshParseError('3MF contains no triangles', '3mf')
    }
  }

  return stats
}

function isValidIndex(value: number, count: number): boolean {
  return Number.isInteger(value) && value >= 0 && value < count
}

/**
 * Finds an embedded thumbnail.
 *
 * Worth doing properly: a slicer-exported 3MF usually carries a real plate
 * render, which is a far better grid thumbnail than anything we would
 * rasterise, and it costs nothing to extract.
 *
 * The OPC relationship file names the thumbnail part, so that is checked first
 * rather than guessing at paths — Bambu, Orca and PrusaSlicer all put theirs
 * somewhere slightly different (`Metadata/plate_1.png`,
 * `Metadata/thumbnail.png`, and others).
 */
function findThumbnail(
  entries: Record<string, Uint8Array>,
): { data: Uint8Array; contentType: string; path: string } | undefined {
  const relsKey = Object.keys(entries).find((key) => key.toLowerCase() === '_rels/.rels')
  if (relsKey && entries[relsKey]) {
    const xml = decodeUtf8(entries[relsKey])
    const match = xml.match(
      /<Relationship[^>]*Type="[^"]*\/thumbnail"[^>]*Target="([^"]+)"/i,
    )
    const target = match?.[1]
    if (target) {
      const normalized = target.replace(/^\//, '')
      const found = entries[normalized] ?? entries[decodeURIComponent(normalized)]
      if (found && found.byteLength > 0) {
        return { data: found, contentType: contentTypeFor(normalized), path: normalized }
      }
    }
  }

  // No usable relationship. Fall back to the conventional locations, preferring
  // a plate render over a generic thumbnail.
  const candidates = Object.keys(entries)
    .filter((key) => /\.(png|jpe?g)$/i.test(key) && entries[key]!.byteLength > 0)
    .sort((a, b) => score(b) - score(a))

  const best = candidates[0]
  return best
    ? { data: entries[best]!, contentType: contentTypeFor(best), path: best }
    : undefined
}

function score(path: string): number {
  const lower = path.toLowerCase()
  if (lower.includes('plate_1')) return 5
  if (lower.includes('plate')) return 4
  if (lower.includes('thumbnail')) return 3
  if (lower.startsWith('metadata/')) return 2
  return 1
}

function contentTypeFor(path: string): string {
  return /\.jpe?g$/i.test(path) ? 'image/jpeg' : 'image/png'
}
