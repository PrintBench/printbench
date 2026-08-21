import { zipSync } from 'fflate'
import { MeshParseError, type BoundingBox, type TriangleVisitor } from '../types'

/**
 * Writing a 3MF.
 *
 * This exists because of one line in Bambu Studio's `Plater::import_model_id`:
 *
 *   if (!extension.Contains(".3mf") && !extension.Contains(".3MF")) {
 *     msg = _L("Download failed, unknown file format."); return; }
 *
 * The check runs *before* the download, so no URL pointing at an STL can ever
 * work — the slicer refuses it without asking the server for a single byte.
 * Handing it a real 3MF is the only way "open in Bambu Studio" can function at
 * all, and every other slicer reads 3MF too.
 *
 * Deliberately minimal: the three parts an importer requires and nothing else.
 * No thumbnails, no build metadata, no slicer-specific extensions. This is a
 * transport container for geometry we already have, not an attempt to become a
 * 3MF authoring tool.
 */

/**
 * 3MF stores coordinates as text, so it is far larger than binary STL before
 * compression — roughly 8x for typical models. This bounds the memory a single
 * conversion can take.
 */
export const MAX_CONVERT_TRIANGLES = 5_000_000

export interface ThreeMfSource {
  /** Streams triangles into the visitor. Called once. */
  each(visit: TriangleVisitor): void | Promise<void>
  /** Triangle count, when known, so the buffer can be sized up front. */
  triangleCount?: number
}

export interface WriteResult {
  data: Uint8Array
  triangleCount: number
  bbox: BoundingBox
}

/** Millimetres. Both STL and 3MF conventionally use them; nothing is rescaled. */
const UNIT = 'millimeter'

/** 1980-01-01T00:00:00Z, the earliest a zip entry can claim. */
const ZIP_EPOCH = 315_532_800_000

/**
 * Builds a 3MF from a triangle soup.
 *
 * Vertices are deduplicated, because 3MF is indexed where STL is not: an STL
 * repeats every shared corner, and writing that out verbatim would triple the
 * vertex list and the file size for no benefit.
 */
export async function writeThreeMf(source: ThreeMfSource): Promise<WriteResult> {
  const vertices: number[] = []
  const indices: number[] = []
  const seen = new Map<string, number>()

  let triangleCount = 0
  const bbox = {
    minX: Infinity,
    minY: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    maxZ: -Infinity,
  }

  /**
   * Keyed on the rounded coordinate triple.
   *
   * Six decimals is below the precision of a 32-bit float at printer scale, so
   * this merges corners that are the same point and never merges corners that
   * are not.
   */
  const indexOf = (x: number, y: number, z: number): number => {
    const key = `${round(x)},${round(y)},${round(z)}`
    const existing = seen.get(key)
    if (existing !== undefined) return existing

    const index = vertices.length / 3
    vertices.push(x, y, z)
    seen.set(key, index)
    return index
  }

  await source.each((triangle) => {
    if (++triangleCount > MAX_CONVERT_TRIANGLES) {
      throw new MeshParseError(
        `Too many triangles to convert (over ${MAX_CONVERT_TRIANGLES.toLocaleString()}).`,
      )
    }

    for (let corner = 0; corner < 3; corner++) {
      const x = triangle[corner * 3]!
      const y = triangle[corner * 3 + 1]!
      const z = triangle[corner * 3 + 2]!

      if (x < bbox.minX) bbox.minX = x
      if (y < bbox.minY) bbox.minY = y
      if (z < bbox.minZ) bbox.minZ = z
      if (x > bbox.maxX) bbox.maxX = x
      if (y > bbox.maxY) bbox.maxY = y
      if (z > bbox.maxZ) bbox.maxZ = z

      indices.push(indexOf(x, y, z))
    }
  })

  if (triangleCount === 0) throw new MeshParseError('The mesh has no triangles.')

  const model = buildModelXml(vertices, indices)
  const encoder = new TextEncoder()

  /*
   * Part names and the relationship type are fixed by the specification.
   * Getting any of them wrong produces a zip that opens fine in an archive tool
   * and is rejected by every slicer, which is a confusing way to fail.
   */
  const data = zipSync(
    {
      '[Content_Types].xml': encoder.encode(CONTENT_TYPES),
      '_rels/.rels': encoder.encode(RELS),
      '3D/3dmodel.model': encoder.encode(model),
    },
    /*
     * Deflate: the XML is highly repetitive text and compresses about 5:1.
     *
     * A fixed timestamp — the zip epoch, since the format cannot represent
     * anything earlier than 1980 — makes the output deterministic. The same
     * mesh must produce the same bytes, or every response is a different object
     * and nothing downstream can cache it.
     */
    { level: 6, mtime: ZIP_EPOCH },
  )

  return { data, triangleCount, bbox }
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

/** Trims trailing zeroes so the XML is not padded with meaningless precision. */
function num(value: number): string {
  return Number.isInteger(value) ? String(value) : String(round(value))
}

function buildModelXml(vertices: number[], indices: number[]): string {
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    `<model unit="${UNIT}" xml:lang="en-US" `,
    'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
    '<metadata name="Application">PrintBench</metadata>',
    '<resources><object id="1" type="model"><mesh><vertices>',
  ]

  for (let i = 0; i < vertices.length; i += 3) {
    parts.push(
      `<vertex x="${num(vertices[i]!)}" y="${num(vertices[i + 1]!)}" z="${num(vertices[i + 2]!)}"/>`,
    )
  }

  parts.push('</vertices><triangles>')

  for (let i = 0; i < indices.length; i += 3) {
    parts.push(`<triangle v1="${indices[i]}" v2="${indices[i + 1]}" v3="${indices[i + 2]}"/>`)
  }

  parts.push('</triangles></mesh></object></resources>')
  // The build section is what tells a slicer to actually place the object.
  parts.push('<build><item objectid="1"/></build></model>')

  return parts.join('')
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
  '</Types>'

const RELS =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Target="/3D/3dmodel.model" Id="rel0" ' +
  'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>' +
  '</Relationships>'
