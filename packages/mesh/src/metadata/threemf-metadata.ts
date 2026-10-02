import { inflateRawSync } from 'node:zlib'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { collectBounded } from '../parse/collect-bounded'
import type { StreamSource } from '../types'

/** Bump when selection/decoding changes so cached plate images are regenerated. */
export const THREEMF_METADATA_VERSION = 2
export const MAX_3MF_METADATA_ARCHIVE_BYTES = 128 * 1024 * 1024
export const MAX_3MF_METADATA_XML_BYTES = 16 * 1024 * 1024
export const MAX_3MF_EMBEDDED_IMAGE_BYTES = 4 * 1024 * 1024
const MAX_RELATIONSHIP_BYTES = 256 * 1024
const MAX_IMAGE_TOTAL_BYTES = 16 * 1024 * 1024
const MAX_ENTRIES = 20_000

export interface EmbeddedThumbnail {
  data: Uint8Array
  path: string
  contentType: 'image/png' | 'image/jpeg'
  /** A plate render is a fallback when no package cover is usable. */
  kind?: 'cover' | 'plate'
}

export interface ThreeMfMetadata {
  title?: string
  designer?: string
  description?: string
  license?: string
  creationDate?: string
  modificationDate?: string
  application?: string
  /** Kept as identifiers, never interpreted as public model URLs. */
  sourceIdentifiers?: Record<string, string>
  /** Covers and fallback plate renders; the renderer chooses a sharp usable cover. */
  thumbnails: EmbeddedThumbnail[]
}

export class ThreeMfMetadataError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ThreeMfMetadataError'
  }
}

export async function readThreeMfMetadataFromSource(
  source: StreamSource,
  options: { byteLength?: number; signal?: AbortSignal } = {},
): Promise<ThreeMfMetadata> {
  return readThreeMfMetadata(
    await collectBounded(source, MAX_3MF_METADATA_ARCHIVE_BYTES, '3mf', options),
  )
}

/**
 * Reads only the OPC main model's metadata, relationships and chosen images.
 * It neither parses geometry nor expands object parts, G-code or remote assets.
 */
export function readThreeMfMetadata(bytes: Uint8Array): ThreeMfMetadata {
  if (bytes.byteLength > MAX_3MF_METADATA_ARCHIVE_BYTES) {
    throw new ThreeMfMetadataError('3MF exceeds the embedded-metadata input budget')
  }
  const root = selectedParts(bytes, new Map([['_rels/.rels', MAX_RELATIONSHIP_BYTES]]))
  const rootRelationships = readRelationships(root.get('_rels/.rels'))
  const mainTarget = rootRelationships.find((r) => r.type.endsWith('/3dmodel'))?.target
  const mainPart = mainTarget ? resolveTarget('', mainTarget) : '3D/3dmodel.model'
  if (!mainPart) return { thumbnails: [] }
  const modelRelationshipsPart = relationshipPart(mainPart)
  const modelParts = selectedParts(
    bytes,
    new Map([
      [mainPart.toLowerCase(), MAX_3MF_METADATA_XML_BYTES],
      [modelRelationshipsPart.toLowerCase(), MAX_RELATIONSHIP_BYTES],
    ]),
  )
  const model = modelParts.get(mainPart.toLowerCase())
  const metadata = model ? modelMetadata(model) : {}
  const modelRelationships = readRelationships(modelParts.get(modelRelationshipsPart.toLowerCase()))
  const candidates = [
    ...thumbnailTargets(rootRelationships, ''),
    ...thumbnailTargets(modelRelationships, mainPart),
  ]
  const explicitCovers = new Set(candidates.map((p) => p.toLowerCase()))
  // Some producers omit OPC cover relationships. Only documented cover locations
  // are considered; arbitrary textures and referenced HTTP images are not covers.
  candidates.push(
    'Auxiliaries/.thumbnails/thumbnail_3mf.png',
    'Auxiliaries/.thumbnails/thumbnail_middle.png',
    'Auxiliaries/.thumbnails/thumbnail_small.png',
    'Metadata/thumbnail.png',
    'Metadata/plate_1.png',
  )
  const unique = [...new Set(candidates.map((p) => p.toLowerCase()))].slice(0, 16)
  const imageParts = selectedParts(
    bytes,
    new Map(unique.map((p) => [p, MAX_3MF_EMBEDDED_IMAGE_BYTES])),
    MAX_IMAGE_TOTAL_BYTES,
    true,
  )
  const thumbnails: EmbeddedThumbnail[] = []
  for (const p of unique) {
    const data = imageParts.get(p)
    if (!data) continue
    const contentType = imageContentType(data)
    if (contentType)
      thumbnails.push({
        path: p,
        data,
        contentType,
        kind: p === 'metadata/plate_1.png' && !explicitCovers.has(p) ? 'plate' : 'cover',
      })
  }
  return { ...metadata, thumbnails }
}

function selectedParts(
  bytes: Uint8Array,
  requested: Map<string, number>,
  maxTotalBytes = MAX_3MF_METADATA_XML_BYTES + 2 * MAX_RELATIONSHIP_BYTES,
  skipOversized = false,
): Map<string, Uint8Array> {
  let total = 0
  const result = new Map<string, Uint8Array>()
  try {
    for (const entry of zipEntries(bytes)) {
      const key = entry.name.toLowerCase()
      const limit = requested.get(key)
      if (!limit) continue
      if (entry.originalSize > limit || total + entry.originalSize > maxTotalBytes) {
        if (skipOversized) continue
        throw new ThreeMfMetadataError('3MF metadata part exceeds its expanded-size budget')
      }
      let data: Uint8Array
      try {
        if (entry.flags & 1) throw new ThreeMfMetadataError('Encrypted metadata is not supported')
        const compressed = bytes.subarray(entry.start, entry.start + entry.compressedSize)
        if (entry.compression === 8) {
          // Limit actual output, not merely the untrusted size claimed by ZIP.
          data = inflateRawSync(compressed, { maxOutputLength: limit })
        } else if (entry.compression === 0 && compressed.byteLength <= limit) {
          data = compressed.slice()
        } else throw new ThreeMfMetadataError('Unsupported metadata compression')
        if (data.byteLength !== entry.originalSize)
          throw new ThreeMfMetadataError('3MF metadata part has an inconsistent expanded size')
      } catch (error) {
        if (skipOversized) continue
        if (error instanceof ThreeMfMetadataError) throw error
        throw new ThreeMfMetadataError('3MF metadata cannot be expanded within its size budget')
      }
      total += data.byteLength
      result.set(key, data)
    }
    return result
  } catch (error) {
    if (error instanceof ThreeMfMetadataError) throw error
    throw new ThreeMfMetadataError('3MF is not a readable ZIP package')
  }
}

interface ZipPart {
  name: string
  flags: number
  compression: number
  originalSize: number
  compressedSize: number
  start: number
}

/**
 * Only indexes ZIP parts, with strict offsets and a bounded entry count. Standard
 * 3MF ZIPs suffice here; ZIP64 declines metadata import rather than guessing at
 * 64-bit offsets. The separate geometry reader still supports those packages.
 */
function zipEntries(bytes: Uint8Array): ZipPart[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u16 = (at: number) => view.getUint16(at, true)
  const u32 = (at: number) => view.getUint32(at, true)
  let end = bytes.length - 22
  const earliest = Math.max(0, bytes.length - 22 - 65535)
  for (; end >= earliest; end--) {
    if (u32(end) === 0x06054b50 && end + 22 + u16(end + 20) === bytes.length) break
  }
  if (end < earliest) throw new ThreeMfMetadataError('3MF has no valid ZIP directory')
  const count = u16(end + 10)
  const directoryBytes = u32(end + 12)
  const directoryStart = u32(end + 16)
  if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== count)
    throw new ThreeMfMetadataError('Multi-disk metadata packages are not supported')
  if (count === 65535 || directoryBytes === 0xffffffff || directoryStart === 0xffffffff)
    throw new ThreeMfMetadataError('ZIP64 metadata import is not supported')
  if (count > MAX_ENTRIES || directoryStart + directoryBytes > end)
    throw new ThreeMfMetadataError('3MF ZIP directory exceeds its budget')
  const entries: ZipPart[] = []
  const names = new Set<string>()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let offset = directoryStart
  for (let index = 0; index < count; index++) {
    if (offset + 46 > directoryStart + directoryBytes || u32(offset) !== 0x02014b50)
      throw new ThreeMfMetadataError('Invalid 3MF ZIP directory entry')
    const nameBytes = u16(offset + 28)
    const extraBytes = u16(offset + 30)
    const commentBytes = u16(offset + 32)
    const next = offset + 46 + nameBytes + extraBytes + commentBytes
    if (next > directoryStart + directoryBytes)
      throw new ThreeMfMetadataError('Truncated 3MF ZIP part name')
    const name = archivePath(decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameBytes)))
    if (!name) throw new ThreeMfMetadataError('3MF contains an unsafe ZIP part name')
    if (names.has(name.toLowerCase()))
      throw new ThreeMfMetadataError('3MF contains ambiguous duplicate parts')
    names.add(name.toLowerCase())
    const local = u32(offset + 42)
    if (local + 30 > directoryStart || u32(local) !== 0x04034b50)
      throw new ThreeMfMetadataError('Invalid 3MF ZIP local header')
    const localNameBytes = u16(local + 26)
    const start = local + 30 + localNameBytes + u16(local + 28)
    const compressedSize = u32(offset + 20)
    if (start + compressedSize > directoryStart)
      throw new ThreeMfMetadataError('Truncated 3MF ZIP part')
    const localName = archivePath(
      decoder.decode(bytes.subarray(local + 30, local + 30 + localNameBytes)),
    )
    if (localName !== name) throw new ThreeMfMetadataError('Mismatched 3MF ZIP part names')
    entries.push({
      name,
      flags: u16(offset + 8),
      compression: u16(offset + 10),
      compressedSize,
      originalSize: u32(offset + 24),
      start,
    })
    offset = next
  }
  return entries
}

/** ZIP names are identifiers only, never paths written to the filesystem. */
function archivePath(value: string): string | null {
  if (!value || value.length > 2000 || /[\\\0:]/.test(value) || value.startsWith('/')) return null
  const parts = value.split('/')
  if (parts.some((p) => p === '..' || p === '.')) return null
  return parts.filter(Boolean).join('/') || null
}

function resolveTarget(basePart: string, value: string): string | null {
  let target: string
  try {
    target = decodeURIComponent(value)
  } catch {
    return null
  }
  if (!target || target.length > 2000 || /[\\\0:?#]/.test(target) || target.startsWith('//'))
    return null
  const parts = target.startsWith('/') ? [] : basePart.split('/').slice(0, -1)
  for (const part of target.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) return null
      parts.pop()
    } else parts.push(part)
  }
  return archivePath(parts.join('/'))
}

function relationshipPart(part: string): string {
  const parts = part.split('/')
  const leaf = parts.pop()!
  return [...parts, '_rels', `${leaf}.rels`].join('/')
}

interface Relationship {
  target: string
  type: string
}

function readRelationships(bytes?: Uint8Array): Relationship[] {
  if (!bytes) return []
  const document = parseXml(bytes)
  const root = isObject(document.Relationships) ? document.Relationships : {}
  const relationships = asArray(root.Relationship)
  return relationships.flatMap((value) => {
    if (!isObject(value) || String(value['@_TargetMode'] ?? '').toLowerCase() === 'external')
      return []
    const target = value['@_Target']
    const type = value['@_Type']
    return typeof target === 'string' && typeof type === 'string'
      ? [{ target: decodeEntities(target), type }]
      : []
  })
}

function thumbnailTargets(relationships: Relationship[], base: string): string[] {
  return relationships
    .map((r, index) => ({
      ...r,
      index,
      priority: r.type.endsWith('/thumbnail')
        ? 0
        : r.type.endsWith('/cover-thumbnail-middle')
          ? 1
          : r.type.endsWith('/cover-thumbnail-small')
            ? 2
            : 99,
    }))
    .filter((r) => r.priority !== 99)
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .flatMap((r) => {
      const part = resolveTarget(base, r.target)
      return part && /\.(png|jpe?g)$/i.test(part) ? [part] : []
    })
}

function modelMetadata(bytes: Uint8Array): Omit<ThreeMfMetadata, 'thumbnails'> {
  const document = parseXml(bytes)
  const fields = new Map<string, string>()
  const model = isObject(document.model) ? document.model : {}
  for (const entry of asArray(model.metadata)) {
    if (!isObject(entry) || typeof entry['@_name'] !== 'string') continue
    const name = entry['@_name'].toLowerCase()
    if (!fields.has(name) && typeof entry['#text'] === 'string') fields.set(name, entry['#text'])
  }
  const text = (key: string, limit: number) =>
    cleanText(decodeEntities(fields.get(key) ?? ''), limit) || undefined
  const identifiers: Record<string, string> = {}
  for (const [key, label] of [
    ['designmodelid', 'MakerWorld internal design ID'],
    ['designprofileid', 'MakerWorld internal profile ID'],
    ['designeruserid', 'Designer user ID'],
  ] as const) {
    const value = text(key, 200)
    if (value) identifiers[label] = value
  }
  return {
    title: text('title', 225),
    designer: text('designer', 225),
    description: plainDescription(fields.get('description') ?? '') || undefined,
    license: text('license', 120),
    creationDate: sourceDate(text('creationdate', 50)),
    modificationDate: sourceDate(text('modificationdate', 50)),
    application: text('application', 200),
    ...(Object.keys(identifiers).length ? { sourceIdentifiers: identifiers } : {}),
  }
}

function parseXml(bytes: Uint8Array): Record<string, unknown> {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(text))
    throw new ThreeMfMetadataError('XML declarations/entities are not allowed in 3MF metadata')
  const valid = XMLValidator.validate(text)
  if (valid !== true) throw new ThreeMfMetadataError('3MF metadata XML is malformed')
  return new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    parseTagValue: false,
    parseAttributeValue: false,
    processEntities: false,
    trimValues: false,
    alwaysCreateTextNode: true,
    // Inline geometry can contain hundreds of thousands of tags. Keep these
    // bounded XML strings instead of building a second geometry object graph.
    stopNodes: ['model.resources', 'model.build'],
    maxNestedTags: 32,
  }).parse(text) as Record<string, unknown>
}

function asArray(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value]
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  hellip: '…',
}

/** Exporters double-escape rich descriptions. Decode a bounded number of layers. */
function decodeEntities(value: string): string {
  let current = value
  for (let pass = 0; pass < 3; pass++) {
    const next = current.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z]+);/gi, (entity, key: string) => {
      if (key.startsWith('#')) {
        const n = key[1]?.toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1))
        return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
          ? String.fromCodePoint(n)
          : ''
      }
      return ENTITIES[key.toLowerCase()] ?? entity
    })
    if (next === current) break
    current = next
  }
  return current
}

function cleanText(value: string, max: number): string {
  // Strip nonprinting controls from untrusted metadata, retaining tabs/newlines.
  // eslint-disable-next-line no-control-regex
  const controls = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g
  return value.replace(controls, '').trim().slice(0, max)
}

function plainDescription(value: string): string {
  const decoded = decodeEntities(value.slice(0, 60_000))
  return cleanText(
    decoded
      .replace(/<(script|style|iframe|object|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<!--[^]*?-->/g, '')
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<\/?(?:p|div|ul|ol|h[1-6]|br|li)\b[^>]*>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n'),
    18_000,
  )
}

function sourceDate(value?: string): string | undefined {
  if (
    !value ||
    !/^\d{4}-\d{2}-\d{2}(?:T[\d:.+-]+Z?)?$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return undefined
  return value
}

function imageContentType(bytes: Uint8Array): EmbeddedThumbnail['contentType'] | null {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n))
    return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return 'image/jpeg'
  return null
}
