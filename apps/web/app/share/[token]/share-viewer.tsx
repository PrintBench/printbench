'use client'

import { ModelPreview } from '@/components/viewer/model-preview'

/**
 * The 3D viewer on a shared page.
 *
 * The same viewer the app uses, pointed at the share file route instead of the
 * authenticated one — an anonymous visitor has no session for the normal route
 * to check.
 */
export function ShareViewer({
  token,
  fileId,
  format,
  fileSize,
  filename,
  thumbnailFileId,
  thumbnailKey,
}: {
  token: string
  fileId: string | null
  format: 'stl' | '3mf' | 'obj' | 'ply'
  fileSize: number
  filename: string
  thumbnailFileId: string | null
  thumbnailKey: string | null
}) {
  const imageUrl = thumbnailFileId
    ? `/api/share/${token}/files/${thumbnailFileId}?thumb=1&v=${encodeURIComponent(thumbnailKey ?? '')}`
    : null
  return (
    <ModelPreview
      name={filename || 'Shared model'}
      imageUrl={imageUrl}
      model={
        fileId
          ? {
              fileId,
              format,
              fileSize,
              filename,
              thumbnailFileId,
              thumbnailKey,
              urlFor: (id, kind) =>
                kind === 'thumb'
                  ? `/api/share/${token}/files/${id}?thumb=1`
                  : `/api/share/${token}/files/${id}?inline=1`,
            }
          : null
      }
    />
  )
}
