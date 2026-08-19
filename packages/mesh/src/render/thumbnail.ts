import sharp from 'sharp'
import { readStl } from '../parse/stl'
import { readThreeMf } from '../parse/threemf'
import { readObj } from '../parse/obj'
import { readPly } from '../parse/ply'
import { MeshParseError, type MeshStats, type StreamSource } from '../types'
import { RENDERER_VERSION, Rasterizer, isRenderable, type RenderOptions } from './rasterizer'

/**
 * Mesh file to thumbnail.
 *
 * Two passes over the source: the first measures the bounding box, the second
 * draws with a camera fitted to it. Two passes rather than one because framing
 * cannot be decided until the extents are known, and buffering the mesh to
 * avoid the second pass is exactly the thing this design refuses to do.
 *
 * Re-reading is cheap next to holding a multi-gigabyte mesh in memory, and on
 * a warm page cache the second pass costs almost nothing.
 */

export interface ThumbnailOptions extends RenderOptions {
  /** Output format. WebP is markedly smaller than PNG at the same quality. */
  format?: 'webp' | 'png'
  quality?: number
  signal?: AbortSignal
}

export interface ThumbnailResult {
  data: Buffer
  contentType: string
  width: number
  height: number
  stats: MeshStats
  /** True when an embedded image was used instead of rendering. */
  embedded: boolean
  rendererVersion: number
}

export type SupportedFormat = 'stl' | '3mf' | 'obj' | 'ply'

export function supportedFormat(extension: string): SupportedFormat | null {
  const lower = extension.toLowerCase().replace(/^\./, '')
  return lower === 'stl' || lower === '3mf' || lower === 'obj' || lower === 'ply' ? lower : null
}

/** Measures a mesh without drawing anything. Used by the analysis job. */
export async function analyzeMesh(
  format: SupportedFormat,
  source: StreamSource,
  options: { byteLength?: number; signal?: AbortSignal } = {},
): Promise<MeshStats> {
  switch (format) {
    case 'stl':
      return readStl(source, noop, options)
    case 'obj':
      return readObj(source, noop, options)
    case 'ply':
      return readPly(source, noop, options)
    case '3mf':
      return readThreeMf(await collect(source), noop)
  }
}

export async function renderThumbnail(
  format: SupportedFormat,
  source: StreamSource,
  options: ThumbnailOptions & { byteLength?: number } = {},
): Promise<ThumbnailResult> {
  const size = options.size ?? 512
  const encode = options.format ?? 'webp'

  /*
   * A 3MF from a slicer usually carries a real plate render. Using it is both
   * faster and better-looking than anything rasterised from geometry, so it
   * takes priority — but the geometry is still parsed, because bounding box and
   * triangle count are wanted regardless.
   */
  if (format === '3mf') {
    const buffer = await collect(source)
    const result = readThreeMf(buffer, noop)
    if (result.thumbnail && result.thumbnail.data.byteLength > 0) {
      try {
        const data = await sharp(Buffer.from(result.thumbnail.data))
          .resize(size, size, { fit: 'inside', withoutEnlargement: true })
          .toFormat(encode, { quality: options.quality ?? 82 })
          .toBuffer()
        return {
          data,
          contentType: encode === 'webp' ? 'image/webp' : 'image/png',
          width: size,
          height: size,
          stats: result,
          embedded: true,
          rendererVersion: RENDERER_VERSION,
        }
      } catch {
        // A corrupt embedded image must not fail the whole thumbnail; fall
        // through and render the geometry instead.
      }
    }
    return rasterise(result, (visit) => void readThreeMf(buffer, visit), options, size, encode)
  }

  const stats = await analyzeMesh(format, source, options)
  return rasterise(
    stats,
    async (visit) => {
      switch (format) {
        case 'stl': return void (await readStl(source, visit, options))
        case 'obj': return void (await readObj(source, visit, options))
        case 'ply': return void (await readPly(source, visit, options))
      }
    },
    options,
    size,
    encode,
  )
}

async function rasterise(
  stats: MeshStats,
  secondPass: (visit: (t: Float32Array) => void) => void | Promise<void>,
  options: ThumbnailOptions,
  size: number,
  encode: 'webp' | 'png',
): Promise<ThumbnailResult> {
  if (!isRenderable(stats.bbox)) {
    throw new MeshParseError('Mesh has no renderable geometry', stats.format)
  }

  const rasterizer = new Rasterizer(stats.bbox, { ...options, size })
  await secondPass((triangle) => rasterizer.addTriangle(triangle))
  const target = rasterizer.finish()

  if (!target.drawn) {
    throw new MeshParseError('Nothing was drawn for this mesh', stats.format)
  }

  /*
   * Crop to what was actually drawn, then downsample.
   *
   * Framing from the bounding box alone systematically over-shrinks round
   * shapes — a sphere's box is a cube, whose projected diagonal is about 1.7x
   * the sphere's silhouette. Cropping to the covered pixels makes framing
   * consistent for any shape, and the bounds came free during rasterising, so
   * there is no extra pass over the file.
   *
   * The crop is squared off around the centre of the content so the model is
   * never distorted, and a margin is added back so it does not touch the edge.
   */
  const crop = squareCrop(target, options.margin ?? 0.08)

  const data = await sharp(Buffer.from(target.pixels.buffer, 0, target.pixels.length), {
    raw: { width: target.width, height: target.height, channels: 4 },
  })
    .extract(crop)
    .resize(size, size, { kernel: 'lanczos3', fit: 'fill' })
    .toFormat(encode, { quality: options.quality ?? 82 })
    .toBuffer()

  return {
    data,
    contentType: encode === 'webp' ? 'image/webp' : 'image/png',
    width: size,
    height: size,
    stats,
    embedded: false,
    rendererVersion: RENDERER_VERSION,
  }
}

async function collect(source: StreamSource): Promise<Buffer> {
  const stream = await source()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

function noop(): void {}

/**
 * A square region around the drawn content, with margin, clamped to the canvas.
 *
 * Squared off so the model is never stretched, and clamped so the extract can
 * never ask sharp for pixels outside the buffer — which throws rather than
 * returning a smaller image.
 */
function squareCrop(
  target: { width: number; height: number; bounds: { minX: number; minY: number; maxX: number; maxY: number } },
  margin: number,
): { left: number; top: number; width: number; height: number } {
  const { minX, minY, maxX, maxY } = target.bounds
  const contentWidth = Math.max(1, maxX - minX + 1)
  const contentHeight = Math.max(1, maxY - minY + 1)

  const side = Math.ceil(Math.max(contentWidth, contentHeight) * (1 + margin * 2))
  const centreX = (minX + maxX) / 2
  const centreY = (minY + maxY) / 2

  // Never larger than the canvas, or the extract is out of bounds.
  const clampedSide = Math.min(side, target.width, target.height)
  const left = Math.round(centreX - clampedSide / 2)
  const top = Math.round(centreY - clampedSide / 2)

  return {
    left: Math.max(0, Math.min(left, target.width - clampedSide)),
    top: Math.max(0, Math.min(top, target.height - clampedSide)),
    width: clampedSide,
    height: clampedSide,
  }
}
