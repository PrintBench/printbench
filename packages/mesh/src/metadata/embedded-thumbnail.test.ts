import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import {
  renderEmbeddedThumbnail,
  renderRemoteThumbnail,
  MAX_3MF_EMBEDDED_IMAGE_PIXELS,
} from './embedded-thumbnail'
import { MAX_3MF_EMBEDDED_IMAGE_BYTES } from './threemf-metadata'

describe('safe embedded cover decoding', () => {
  it('prefers a usable cover and returns real output dimensions', async () => {
    const png = await sharp({
      create: { width: 30, height: 20, channels: 3, background: '#336699' },
    })
      .png()
      .toBuffer()
    const result = await renderEmbeddedThumbnail(
      [
        {
          path: 'broken.png',
          data: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
          contentType: 'image/png',
        },
        { path: 'cover.png', data: png, contentType: 'image/png' },
      ],
      { size: 15 },
    )
    expect(result?.width).toBe(15)
    expect(result?.height).toBe(10)
    expect((await sharp(result!.data).metadata()).format).toBe('webp')
  })

  it('rejects oversized bytes and non-raster content even under a PNG filename', async () => {
    expect(
      await renderEmbeddedThumbnail([
        {
          path: 'large.png',
          data: new Uint8Array(MAX_3MF_EMBEDDED_IMAGE_BYTES + 1),
          contentType: 'image/png',
        },
        {
          path: 'fake.png',
          data: Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="file:///etc/passwd"/></svg>',
          ),
          contentType: 'image/png',
        },
      ]),
    ).toBeNull()
  })

  it('rejects compressed images above the decoder pixel budget', async () => {
    const edge = Math.floor(Math.sqrt(MAX_3MF_EMBEDDED_IMAGE_PIXELS)) + 1
    const image = await sharp({
      create: { width: edge, height: edge, channels: 3, background: '#000000' },
    })
      .png()
      .toBuffer()
    expect(image.length).toBeLessThan(MAX_3MF_EMBEDDED_IMAGE_BYTES)
    expect(
      await renderEmbeddedThumbnail([{ path: 'huge.png', data: image, contentType: 'image/png' }]),
    ).toBeNull()
    expect(await renderRemoteThumbnail(image)).toBeNull()
  })
})

describe('safe remote artwork decoding', () => {
  it.each(['png', 'jpeg', 'webp'] as const)('converts %s artwork with bounded dimensions', async (format) => {
    const input = await sharp({
      create: { width: 30, height: 20, channels: 3, background: '#336699' },
    })
      .toFormat(format)
      .toBuffer()
    const result = await renderRemoteThumbnail(input, { size: 15 })
    expect(result).toMatchObject({ contentType: 'image/webp', width: 15, height: 10 })
    expect((await sharp(result!.data).metadata()).format).toBe('webp')
    if (format === 'webp') {
      expect(
        await renderEmbeddedThumbnail([{ path: 'cover.png', data: input, contentType: 'image/png' }]),
      ).toBeNull()
    }
  })

  it('rejects oversized, corrupt, vector and animated artwork', async () => {
    expect(await renderRemoteThumbnail(new Uint8Array(MAX_3MF_EMBEDDED_IMAGE_BYTES + 1))).toBeNull()
    expect(await renderRemoteThumbnail(Buffer.from('RIFF0000WEBP'))).toBeNull()
    expect(
      await renderRemoteThumbnail(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')),
    ).toBeNull()
    const pixels = Buffer.alloc(10 * 20 * 3, 0)
    pixels.fill(255, 10 * 10 * 3)
    const animated = await sharp(pixels, {
      raw: { width: 10, height: 20, pageHeight: 10, channels: 3 },
    })
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer()
    expect((await sharp(animated).metadata()).pages).toBe(2)
    expect(await renderRemoteThumbnail(animated)).toBeNull()
  })
})
