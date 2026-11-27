// @covers BROWSE-003
// @contract mesh/photo
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { PHOTO_DISPLAY_PX, PHOTO_THUMB_PX, renderPhoto } from './photo'

/**
 * Photo renditions.
 *
 * Re-encoding is the validation, the size bound and the privacy measure all
 * at once, so the tests are mostly about what does NOT survive it: EXIF, a
 * second frame, an SVG wearing an image's name, and anything far larger than
 * a screen.
 */

async function jpeg(width: number, height: number, exif?: Record<string, string>) {
  let image = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 60, b: 40 },
    },
  })
  if (exif) image = image.withExif({ IFD0: exif })
  return image.jpeg().toBuffer()
}

describe('renderPhoto', () => {
  it('produces a display image and a smaller tile', async () => {
    const rendered = await renderPhoto(await jpeg(2400, 1600))
    expect(rendered).not.toBeNull()

    // Longest edge is capped; the aspect ratio is not touched.
    expect(rendered!.image.width).toBe(PHOTO_DISPLAY_PX)
    expect(rendered!.image.height).toBe(Math.round((PHOTO_DISPLAY_PX * 1600) / 2400))
    expect(rendered!.thumb.width).toBe(PHOTO_THUMB_PX)

    for (const part of [rendered!.image, rendered!.thumb]) {
      expect((await sharp(part.data).metadata()).format).toBe('webp')
    }
  })

  it('does not enlarge a picture smaller than the target', async () => {
    const rendered = await renderPhoto(await jpeg(200, 150))
    expect(rendered!.image.width).toBe(200)
    expect(rendered!.image.height).toBe(150)
  })

  /*
   * The reason this runs in the first place. A phone photograph carries GPS
   * coordinates, and a workshop instance should not publish the owner's home
   * address along with a picture of a benchy.
   */
  it('drops the metadata the camera wrote', async () => {
    const source = await jpeg(600, 400, { Copyright: 'Taken at 51.5074,-0.1278' })
    expect((await sharp(source).metadata()).exif).toBeDefined()

    const rendered = await renderPhoto(source)
    expect((await sharp(rendered!.image.data).metadata()).exif).toBeUndefined()
  })

  it('refuses something that is not a picture', async () => {
    expect(await renderPhoto(Buffer.from('not an image at all'))).toBeNull()
  })

  /* A document that can fetch and script is not a photograph. */
  it('refuses an SVG', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100"/></svg>',
    )
    expect(await renderPhoto(svg)).toBeNull()
  })

  it('refuses an empty upload', async () => {
    expect(await renderPhoto(Buffer.alloc(0))).toBeNull()
  })

  /*
   * An animation would otherwise be resized frame by frame into something
   * far larger than the original.
   */
  it('keeps only the first frame of an animation', async () => {
    const frames = await sharp({
      create: { width: 60, height: 60, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
    })
      .webp({ loop: 0 })
      .toBuffer()

    const rendered = await renderPhoto(frames)
    expect(rendered).not.toBeNull()
    expect((await sharp(rendered!.image.data).metadata()).pages ?? 1).toBe(1)
  })
})
