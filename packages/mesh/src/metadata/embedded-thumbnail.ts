import sharp from 'sharp'
import { MAX_3MF_EMBEDDED_IMAGE_BYTES, type EmbeddedThumbnail } from './threemf-metadata'

export const MAX_3MF_EMBEDDED_IMAGE_PIXELS = 16 * 1024 * 1024

/** No SVG, animated image, remote URL or unbounded decoder reaches the preview store. */
export async function renderEmbeddedThumbnail(
  candidates: readonly EmbeddedThumbnail[],
  options: { size?: number; quality?: number } = {},
): Promise<{ data: Buffer; contentType: 'image/webp'; width: number; height: number } | null> {
  const size = Math.max(1, Math.min(2048, Math.round(options.size ?? 512)))
  for (const candidate of candidates) {
    if (!candidate.data.byteLength || candidate.data.byteLength > MAX_3MF_EMBEDDED_IMAGE_BYTES)
      continue
    const png =
      candidate.data.length >= 8 &&
      [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => candidate.data[i] === n)
    const jpeg =
      candidate.data.length >= 3 &&
      candidate.data[0] === 255 &&
      candidate.data[1] === 216 &&
      candidate.data[2] === 255
    if (!png && !jpeg) continue
    try {
      const image = sharp(Buffer.from(candidate.data), {
        limitInputPixels: MAX_3MF_EMBEDDED_IMAGE_PIXELS,
        animated: false,
        failOn: 'error',
        sequentialRead: true,
      })
      const metadata = await image.metadata()
      if (
        !['png', 'jpeg'].includes(metadata.format ?? '') ||
        (metadata.pages ?? 1) !== 1 ||
        !metadata.width ||
        !metadata.height ||
        metadata.width * metadata.height > MAX_3MF_EMBEDDED_IMAGE_PIXELS
      )
        continue
      const { data, info } = await image
        .resize(size, size, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: options.quality ?? 82 })
        .toBuffer({ resolveWithObject: true })
      return { data, contentType: 'image/webp', width: info.width, height: info.height }
    } catch {
      // An invalid cover is metadata trouble, not an invalid mesh.
    }
  }
  return null
}
