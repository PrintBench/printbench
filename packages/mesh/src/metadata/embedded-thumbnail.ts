import sharp from 'sharp'
import { MAX_3MF_EMBEDDED_IMAGE_BYTES, type EmbeddedThumbnail } from './threemf-metadata'

export const MAX_3MF_EMBEDDED_IMAGE_PIXELS = 16 * 1024 * 1024

type ThumbnailOptions = { size?: number; quality?: number }
type ThumbnailImage = { data: Buffer; contentType: 'image/webp'; width: number; height: number }

/** No SVG, animated image, remote URL or unbounded decoder reaches the preview store. */
export async function renderEmbeddedThumbnail(
  candidates: readonly EmbeddedThumbnail[],
  options: ThumbnailOptions = {},
): Promise<ThumbnailImage | null> {
  for (const candidate of candidates) {
    const image = await renderRasterThumbnail(candidate.data, options, false)
    if (image) return image
  }
  return null
}

/** Provider artwork may also be WebP; embedded OPC thumbnails remain PNG/JPEG only. */
export async function renderRemoteThumbnail(
  data: Uint8Array,
  options: ThumbnailOptions = {},
): Promise<ThumbnailImage | null> {
  return renderRasterThumbnail(data, options, true)
}

async function renderRasterThumbnail(
  input: Uint8Array,
  options: ThumbnailOptions,
  allowWebp: boolean,
): Promise<ThumbnailImage | null> {
  if (!input.byteLength || input.byteLength > MAX_3MF_EMBEDDED_IMAGE_BYTES) return null
  const png =
    input.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => input[i] === n)
  const jpeg = input.length >= 3 && input[0] === 255 && input[1] === 216 && input[2] === 255
  const webp =
    allowWebp &&
    input.length >= 12 &&
    [82, 73, 70, 70].every((n, i) => input[i] === n) &&
    [87, 69, 66, 80].every((n, i) => input[i + 8] === n)
  if (!png && !jpeg && !webp) return null
  try {
    const image = sharp(Buffer.from(input), {
      limitInputPixels: MAX_3MF_EMBEDDED_IMAGE_PIXELS,
      animated: false,
      failOn: 'error',
      sequentialRead: true,
    })
    const metadata = await image.metadata()
    if (
      !(allowWebp ? ['png', 'jpeg', 'webp'] : ['png', 'jpeg']).includes(metadata.format ?? '') ||
      (metadata.pages ?? 1) !== 1 ||
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height > MAX_3MF_EMBEDDED_IMAGE_PIXELS
    )
      return null
    const size = Math.max(1, Math.min(2048, Math.round(options.size ?? 512)))
    const { data, info } = await image
      .resize(size, size, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: options.quality ?? 82 })
      .toBuffer({ resolveWithObject: true })
    return { data, contentType: 'image/webp', width: info.width, height: info.height }
  } catch {
    // Unusable artwork should leave the normal geometry-preview path available.
    return null
  }
}
