'use client'

import { Box, LoaderCircle } from 'lucide-react'
import { usePreviewStatus } from './preview-status-provider'
import { previewSource } from './preview-source'

export function CardPreview({
  publicId,
  previewImageFileId,
  thumbFileId,
  thumbKey,
  hue,
}: {
  publicId: string
  previewImageFileId?: string | null
  thumbFileId?: string | null
  thumbKey?: string | null
  hue: number
}) {
  const status = usePreviewStatus(publicId, !previewImageFileId && !thumbFileId)
  const source = previewSource({ previewImageFileId, thumbFileId, thumbKey }, status)
  if (source) {
    return (
      // Plain img: generated previews are already sized WebP images.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={source}
        alt=""
        loading="lazy"
        decoding="async"
        style={{
          background: `linear-gradient(160deg, oklch(96% 0.012 ${hue}), oklch(90% 0.02 ${hue + 20}))`,
        }}
        className="size-full object-contain transition-transform duration-200 group-hover:scale-[1.03]"
      />
    )
  }
  return (
    <div className="flex flex-col items-center gap-2 text-white/90">
      {status?.state === 'pending' ? (
        <LoaderCircle className="size-8 motion-safe:animate-spin" aria-hidden />
      ) : (
        <Box className="size-8 text-white/70" strokeWidth={1.5} aria-hidden />
      )}
      {status && (
        <span role="status" className="text-xs font-medium">
          {status.state === 'pending' ? 'Processing…' : 'Preview unavailable'}
        </span>
      )}
    </div>
  )
}
