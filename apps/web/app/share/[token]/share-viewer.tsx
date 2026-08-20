'use client'

import { ModelViewer } from '@/components/viewer/model-viewer'
import { Card } from '@/components/ui/card'

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
}: {
  token: string
  fileId: string | null
  format: 'stl' | '3mf' | 'obj' | 'ply'
  fileSize: number
  filename: string
  thumbnailFileId: string | null
}) {
  if (!fileId) {
    if (!thumbnailFileId) return null
    return (
      <Card className="overflow-hidden">
        <div className="flex aspect-[16/10] items-center justify-center bg-[var(--color-surface-2)]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/share/${token}/files/${thumbnailFileId}?thumb=1`}
            alt=""
            className="size-full object-contain p-4"
          />
        </div>
      </Card>
    )
  }

  return (
    <ModelViewer
      fileId={fileId}
      format={format}
      fileSize={fileSize}
      filename={filename}
      thumbnailFileId={thumbnailFileId}
      urlFor={(id, kind) =>
        kind === 'thumb'
          ? `/api/share/${token}/files/${id}?thumb=1`
          : `/api/share/${token}/files/${id}?inline=1`
      }
      className="aspect-[16/10]"
    />
  )
}
