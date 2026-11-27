// @covers BROWSE-003
// @contract core/photo-store
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PhotoStore, isPhotoKey, photoKey } from './photo-store'

/**
 * The photo store.
 *
 * It holds the only copy of something a person uploaded, so the two things
 * worth proving are that a key cannot point outside the root and that the
 * two renditions of one picture never collide.
 */

describe('photoKey', () => {
  const picture = Buffer.from('pretend this is a webp')

  it('shards two levels deep and ends in .webp', () => {
    const key = photoKey(picture, 'image')
    expect(isPhotoKey(key)).toBe(true)
    expect(key.split('/')).toHaveLength(3)
  })

  it('gives the same picture the same key', () => {
    expect(photoKey(picture, 'image')).toBe(photoKey(Buffer.from(picture), 'image'))
  })

  /*
   * Content addressing alone would put a tiny tile and its full-size image at
   * the same key if they ever encoded identically. The variant keeps them
   * apart whatever the bytes do.
   */
  it('keeps the display image and its tile apart', () => {
    expect(photoKey(picture, 'image')).not.toBe(photoKey(picture, 'thumb'))
  })

  it('rejects anything that is not a generated key', () => {
    for (const bad of [
      '../../etc/passwd',
      'aa/bb/cccc.png',
      'aa/bb/../../../x.webp',
      'aabb/cc.webp',
      '',
    ]) {
      expect(isPhotoKey(bad)).toBe(false)
    }
  })
})

describe('PhotoStore', () => {
  let root: string
  let store: PhotoStore

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'pb-photos-'))
    store = new PhotoStore(root)
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('writes, reads back and deletes', async () => {
    const data = Buffer.from('an image, honestly')
    const key = photoKey(data, 'image')

    expect(await store.has(key)).toBe(false)
    await store.write(key, data)
    expect(await store.has(key)).toBe(true)
    expect(await store.read(key)).toEqual(data)

    await store.delete(key)
    expect(await store.has(key)).toBe(false)
    expect(await store.read(key)).toBeNull()
  })

  it('stays inside its own root', async () => {
    expect(store.absolutePath(photoKey(Buffer.from('x'), 'image')).startsWith(root)).toBe(true)
  })

  /* This path reaches the filesystem and, in production, nginx. */
  it('refuses a malformed key rather than touching the disk', () => {
    expect(() => store.absolutePath('../../../etc/passwd')).toThrow(/malformed/)
  })

  it('names an internal path nginx can serve', () => {
    const key = photoKey(Buffer.from('x'), 'thumb')
    expect(store.internalPath(key)).toBe(`/_photos/${key}`)
  })
})
