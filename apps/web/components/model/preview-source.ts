import type { ModelPreviewStatus } from '@pb/core'

/** A status update may supply a render, but must never replace selected artwork. */
export function previewSource(
  selected: {
    previewImageFileId?: string | null
    thumbFileId?: string | null
    thumbKey?: string | null
  },
  status?: ModelPreviewStatus,
): string | null {
  const imageId = selected.previewImageFileId || status?.previewImageFileId
  if (imageId) return `/api/files/${imageId}/raw?inline=1`
  const thumbnailId = selected.thumbFileId || status?.thumbFileId
  if (!thumbnailId) return null
  const key = selected.thumbFileId ? selected.thumbKey : status?.thumbKey
  return `/api/files/${thumbnailId}/thumb${key ? `?v=${encodeURIComponent(key)}` : ''}`
}
