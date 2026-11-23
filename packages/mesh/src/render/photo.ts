import sharp from 'sharp'

/**
 * Turns an uploaded photograph into the two renditions the app serves.
 *
 * Nothing the browser sent is stored as it arrived. Re-encoding is the point,
 * not a side effect:
 *
 *  - It is the validation. A file that sharp will not decode as one of the
 *    formats below never reaches disk, so "image/jpeg" in a Content-Type
 *    header proves nothing and does not have to.
 *  - It strips metadata. Phone photographs carry GPS coordinates, and a
 *    self-hosted instance shared with a workshop should not quietly publish
 *    the owner's home address along with a picture of a benchy.
 *  - It bounds the size. A 48-megapixel original becomes a few hundred
 *    kilobytes, which is what makes serving these from the web tier
 *    reasonable at all.
 *
 * SVG is refused outright — it is a document that can fetch and script, not a
 * picture — and so is anything animated, which `pages` catches.
 */

/** Longest edge of the image shown when a photo is opened. */
export const PHOTO_DISPLAY_PX = 1600
/** Longest edge of the grid tile. */
export const PHOTO_THUMB_PX = 480

/** Beyond this, decoding costs more than the picture is worth. */
export const MAX_PHOTO_PIXELS = 64 * 1024 * 1024

const ACCEPTED = ['jpeg', 'png', 'webp', 'avif', 'heif', 'tiff', 'gif']

export interface PhotoRendition {
  data: Buffer
  width: number
  height: number
}

export interface PhotoRenditions {
  image: PhotoRendition
  thumb: PhotoRendition
}

function open(input: Buffer) {
  return sharp(input, {
    limitInputPixels: MAX_PHOTO_PIXELS,
    // A multi-frame GIF or WebP would otherwise be resized frame by frame
    // into something far larger than the original.
    animated: false,
    failOn: 'error',
    sequentialRead: true,
  })
}

/**
 * Null when the bytes are not a picture this app will take. The caller turns
 * that into a message; it is never an exception, because an unreadable upload
 * is an ordinary thing for a person to do.
 */
export async function renderPhoto(input: Buffer): Promise<PhotoRenditions | null> {
  try {
    const metadata = await open(input).metadata()

    if (!ACCEPTED.includes(metadata.format ?? '')) return null
    if (!metadata.width || !metadata.height) return null
    if (metadata.width * metadata.height > MAX_PHOTO_PIXELS) return null

    const [image, thumb] = await Promise.all([
      encode(input, PHOTO_DISPLAY_PX, 82),
      encode(input, PHOTO_THUMB_PX, 78),
    ])

    return { image, thumb }
  } catch {
    return null
  }
}

async function encode(input: Buffer, size: number, quality: number): Promise<PhotoRendition> {
  const { data, info } = await open(input)
    // Honours the EXIF orientation flag before that metadata is dropped, so a
    // photo taken sideways is not stored sideways.
    .rotate()
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality })
    .toBuffer({ resolveWithObject: true })

  return { data, width: info.width, height: info.height }
}
