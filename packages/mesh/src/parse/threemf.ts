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
 *
 * **The production extension matters more than it sounds.** A project file
 * saved by Bambu Studio or Orca declares `requiredextensions="p"` and puts no
 * geometry in 3dmodel.model at all — that part holds only `<component>`
 * references to `3D/Objects/*.model`, each with its own transform. Reading the
 * root part alone finds no mesh and concludes the file is empty, which is what
 * used to happen: no thumbnail, no dimensions, nothing in the viewer, for the
 * single most common kind of 3MF a Bambu owner has.
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

  const stats = readPackage(entries, modelKey, visit)
  const thumbnail = findThumbnail(entries)
  return thumbnail ? { ...stats, thumbnail } : stats
}

/**
 * Reads the root part, following component references into the other parts.
 *
 * Every `.model` in the package is parsed up front rather than resolved
 * lazily: there are only ever a handful, and it keeps path resolution — which
 * has to cope with leading slashes, case differences and both separators — in
 * one place.
 */
function readPackage(
  entries: Record<string, Uint8Array>,
  rootKey: string,
  visit: TriangleVisitor,
): MeshStats {
  const parts = new Map<string, ParsedPart>()

  for (const [key, bytes] of Object.entries(entries)) {
    if (!key.toLowerCase().endsWith('.model')) continue
    try {
      parts.set(normalisePart(key), parsePart(decodeUtf8(bytes)))
    } catch {
      // One unreadable part must not condemn the package; the root is the
      // only one whose failure is fatal, and that is checked below.
      continue
    }
  }

  const root = parts.get(normalisePart(rootKey))
  if (!root) throw new MeshParseError('3MF XML has no <model> element', '3mf')

  const stats: MeshStats = {
    triangleCount: 0,
    bbox: newBox(),
    degenerateCount: 0,
    format: '3mf',
    unit: 'mm',
  }

  const emit = makeEmitter(stats, visit)

  /*
   * Build items are the authoritative list of what is on the plate, and the
   * only place the placement transforms live. Two objects sitting apart on the
   * plate would otherwise both land at the origin and report a bounding box
   * far smaller than the real one.
   */
  for (const item of root.items) {
    const part = item.path ? (parts.get(normalisePart(item.path)) ?? root) : root
    resolveObject(parts, part, item.objectId, item.transform, emit, 0)
  }

  /*
   * Fallback for a package with no build section — some exporters omit it.
   * Emitting every mesh untransformed is what this parser did before it
   * understood components, so nothing that used to work can regress.
   */
  if (stats.triangleCount === 0) {
    for (const object of root.objects.values()) {
      if (object.mesh) emit(object.mesh, IDENTITY, root.scale)
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

/** Guards against a component graph that references itself. */
const MAX_COMPONENT_DEPTH = 12

function resolveObject(
  parts: Map<string, ParsedPart>,
  part: ParsedPart,
  objectId: string,
  transform: Matrix,
  emit: Emitter,
  depth: number,
): void {
  if (depth > MAX_COMPONENT_DEPTH) return

  const object = part.objects.get(objectId)
  if (!object) return

  if (object.mesh) {
    emit(object.mesh, transform, part.scale)
    return
  }

  for (const component of object.components) {
    /*
     * A component names an object in ANOTHER part, so ids are only unique
     * within their own file. Resolving against the wrong part silently draws
     * the wrong shape.
     */
    const target = component.path ? parts.get(normalisePart(component.path)) : part
    if (!target) continue

    resolveObject(parts, target, component.objectId, multiply(transform, component.transform), emit, depth + 1)
  }
}

/** Zip keys, relationship targets and p:path values all spell paths differently. */
function normalisePart(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
}

/** A 4x3 affine transform, as 3MF writes it: nine rotation terms then three translation. */
type Matrix = readonly number[]

const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]

interface MeshData {
  vertices: Float32Array
  triangles: Int32Array
}

interface ObjectDef {
  mesh?: MeshData
  components: { objectId: string; path?: string; transform: Matrix }[]
}

interface BuildItem {
  objectId: string
  path?: string
  transform: Matrix
}

interface ParsedPart {
  objects: Map<string, ObjectDef>
  items: BuildItem[]
  /** Millimetres per unit for this part; parts may declare their own. */
  scale: number
}

type Emitter = (mesh: MeshData, transform: Matrix, scale: number) => void

/**
 * Parses "a b c d e f g h i j k l" into a 4x3 matrix.
 *
 * 3MF uses row vectors, so a point is [x y z 1] * M and the last three numbers
 * are the translation. Getting the convention backwards transposes every
 * rotation, which looks plausible until a model comes out mirrored.
 */
function parseMatrix(value: unknown): Matrix {
  if (typeof value !== 'string') return IDENTITY

  const parts = value.trim().split(/\s+/).map(Number)
  if (parts.length !== 12 || parts.some((n) => !Number.isFinite(n))) return IDENTITY
  return parts
}

/** Composes two transforms: apply `inner` first, then `outer`. */
function multiply(outer: Matrix, inner: Matrix): Matrix {
  const out: number[] = new Array(12)

  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      out[row * 3 + col] =
        inner[row * 3]! * outer[col]! +
        inner[row * 3 + 1]! * outer[3 + col]! +
        inner[row * 3 + 2]! * outer[6 + col]!
    }
  }

  for (let col = 0; col < 3; col++) {
    out[9 + col] =
      inner[9]! * outer[col]! +
      inner[10]! * outer[3 + col]! +
      inner[11]! * outer[6 + col]! +
      outer[9 + col]!
  }

  return out
}

function isIdentity(m: Matrix): boolean {
  return m === IDENTITY || IDENTITY.every((value, i) => m[i] === value)
}

/** Accumulates stats and forwards transformed triangles to the caller. */
function makeEmitter(stats: MeshStats, visit: TriangleVisitor): Emitter {
  const triangle = new Float32Array(9)

  return (mesh, transform, scale) => {
    const identity = isIdentity(transform)
    const { vertices, triangles } = mesh
    const vertexCount = vertices.length / 3

    for (let i = 0; i < triangles.length; i += 3) {
      let ok = true

      for (let corner = 0; corner < 3; corner++) {
        const index = triangles[i + corner]!
        if (index < 0 || index >= vertexCount) {
          ok = false
          break
        }

        const x = vertices[index * 3]!
        const y = vertices[index * 3 + 1]!
        const z = vertices[index * 3 + 2]!

        if (identity) {
          triangle[corner * 3] = x * scale
          triangle[corner * 3 + 1] = y * scale
          triangle[corner * 3 + 2] = z * scale
        } else {
          triangle[corner * 3] =
            (x * transform[0]! + y * transform[3]! + z * transform[6]! + transform[9]!) * scale
          triangle[corner * 3 + 1] =
            (x * transform[1]! + y * transform[4]! + z * transform[7]! + transform[10]!) * scale
          triangle[corner * 3 + 2] =
            (x * transform[2]! + y * transform[5]! + z * transform[8]! + transform[11]!) * scale
        }
      }

      // A malformed index is skipped, not read out of bounds.
      if (!ok) continue

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
}

/** Parses one `.model` part into its objects and build items. */
function parsePart(xml: string): ParsedPart {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    // Objects with one child must still be arrays, or a single-mesh model and
    // a multi-mesh one take different code paths.
    isArray: (name) => ['object', 'vertex', 'triangle', 'item', 'component'].includes(name),
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
  const objectNodes = (resources?.object ?? []) as Record<string, unknown>[]

  const objects = new Map<string, ObjectDef>()

  for (const node of objectNodes) {
    const id = String(node['@id'] ?? '')
    if (!id) continue

    const componentNodes = ((node.components as Record<string, unknown>)?.component ??
      []) as Record<string, unknown>[]

    objects.set(id, {
      mesh: readMesh(node.mesh as Record<string, unknown> | undefined),
      components: componentNodes.map((component) => ({
        objectId: String(component['@objectid'] ?? ''),
        // The namespace prefix is conventionally "p", but only conventionally.
        path: attr(component, 'path'),
        transform: parseMatrix(component['@transform']),
      })),
    })
  }

  const itemNodes = ((model.build as Record<string, unknown>)?.item ?? []) as Record<
    string,
    unknown
  >[]

  const items: BuildItem[] = itemNodes
    .map((item) => ({
      objectId: String(item['@objectid'] ?? ''),
      path: attr(item, 'path'),
      transform: parseMatrix(item['@transform']),
    }))
    .filter((item) => item.objectId)

  return { objects, items, scale }
}

/** Reads an attribute whatever namespace prefix it carries. */
function attr(node: Record<string, unknown>, name: string): string | undefined {
  const direct = node[`@${name}`]
  if (typeof direct === 'string') return direct

  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@') && key.toLowerCase().endsWith(`:${name}`) && typeof value === 'string') {
      return value
    }
  }
  return undefined
}

function readMesh(mesh: Record<string, unknown> | undefined): MeshData | undefined {
  if (!mesh) return undefined

  const vertexNodes = ((mesh.vertices as Record<string, unknown>)?.vertex ?? []) as Record<
    string,
    unknown
  >[]
  const triangleNodes = ((mesh.triangles as Record<string, unknown>)?.triangle ?? []) as Record<
    string,
    unknown
  >[]

  if (vertexNodes.length === 0 || triangleNodes.length === 0) return undefined

  // Flat typed arrays rather than objects: a dense mesh has millions of these.
  const vertices = new Float32Array(vertexNodes.length * 3)
  for (let i = 0; i < vertexNodes.length; i++) {
    const node = vertexNodes[i]!
    vertices[i * 3] = Number(node['@x'])
    vertices[i * 3 + 1] = Number(node['@y'])
    vertices[i * 3 + 2] = Number(node['@z'])
  }

  const triangles = new Int32Array(triangleNodes.length * 3)
  for (let i = 0; i < triangleNodes.length; i++) {
    const node = triangleNodes[i]!
    triangles[i * 3] = toIndex(node['@v1'])
    triangles[i * 3 + 1] = toIndex(node['@v2'])
    triangles[i * 3 + 2] = toIndex(node['@v3'])
  }

  return { vertices, triangles }
}

function toIndex(value: unknown): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : -1
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
