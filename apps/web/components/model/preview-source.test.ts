import { describe, expect, it } from 'vitest'
import { previewSource } from './preview-source'

describe('card preview source', () => {
  const ready = {
    publicId: 'model',
    state: 'ready' as const,
    previewImageFileId: null,
    thumbFileId: 'render',
    thumbKey: 'render key',
  }
  it('never replaces a creator image with a newly generated thumbnail', () => {
    expect(previewSource({ previewImageFileId: 'creator', thumbFileId: 'render' }, ready)).toBe(
      '/api/files/creator/raw?inline=1',
    )
  })
  it('uses creator artwork discovered during processing ahead of the render', () => {
    expect(previewSource({}, { ...ready, previewImageFileId: 'imported-cover' })).toBe(
      '/api/files/imported-cover/raw?inline=1',
    )
  })
  it('versions generated thumbnails, including server-provided keys used by metadata imports', () => {
    expect(previewSource({}, ready)).toBe('/api/files/render/thumb?v=render%20key')
    expect(previewSource({ thumbFileId: 'initial', thumbKey: 'import-key' }, ready)).toBe(
      '/api/files/initial/thumb?v=import-key',
    )
  })
  it('keeps the placeholder while no preview is ready', () => {
    expect(
      previewSource({}, { ...ready, state: 'pending', thumbFileId: null, thumbKey: null }),
    ).toBeNull()
  })
})
