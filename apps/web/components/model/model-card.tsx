import Link from 'next/link'
import { Box, FileStack } from 'lucide-react'
import { cn } from '@/lib/cn'

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

/** Millimetres, rounded the way a printer would quote them. */
export function formatDimensions(x?: number, y?: number, z?: number): string | null {
  if (!x || !y) return null
  const round = (value: number) => (value >= 100 ? Math.round(value) : Math.round(value * 10) / 10)
  return `${round(x)} × ${round(y)} × ${round(z ?? 0)} mm`
}

export interface ModelCardProps {
  publicId: string
  name: string
  path: string
  fileCount: number
  totalSize: number
  libraryName?: string
  previewExtension?: string | null
  /** Set once a thumbnail has been rendered for the preview file. */
  thumbFileId?: string | null
  dimensions?: string | null
}

export function ModelCard({
  publicId,
  name,
  path,
  fileCount,
  totalSize,
  libraryName,
  previewExtension,
  thumbFileId,
  dimensions,
}: ModelCardProps) {
  const hue = hashHue(publicId)

  return (
    <Link
      href={`/models/${publicId}`}
      className={cn(
        'group flex flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)]',
        'transition-shadow hover:shadow-[var(--shadow-card)]',
      )}
    >
      <div
        className="relative flex aspect-[4/3] items-center justify-center overflow-hidden"
        style={
          thumbFileId
            ? // A subtle tint behind the render, so a transparent thumbnail still
              // sits on something rather than floating on the card colour.
              {
                background: `linear-gradient(160deg, oklch(96% 0.012 ${hue}), oklch(90% 0.02 ${hue + 20}))`,
              }
            : {
                background: `linear-gradient(145deg, oklch(72% 0.07 ${hue}) 0%, oklch(58% 0.09 ${hue + 24}) 100%)`,
              }
        }
      >
        {thumbFileId ? (
          // Plain img rather than next/image: these are already the right size,
          // already WebP, and immutably cached, so the optimiser adds only cost.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/files/${thumbFileId}/thumb`}
            alt=""
            loading="lazy"
            decoding="async"
            className="size-full object-contain transition-transform duration-200 group-hover:scale-[1.03]"
          />
        ) : (
          <Box className="size-8 text-white/70" strokeWidth={1.5} />
        )}

        {previewExtension && (
          <span className="absolute bottom-2 right-2 rounded bg-black/35 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white/90 backdrop-blur-sm">
            {previewExtension}
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-1 p-3">
        <h3
          className="line-clamp-2 text-sm font-medium leading-snug group-hover:text-[var(--color-accent)]"
          title={name}
        >
          {name}
        </h3>
        <p className="truncate text-xs text-[var(--color-ink-faint)]" title={path}>
          {libraryName ? `${libraryName} · ` : ''}
          {path}
        </p>
        <p className="mt-auto flex items-center gap-1.5 pt-1 text-xs text-[var(--color-ink-muted)]">
          <FileStack className="size-3" />
          {fileCount} file{fileCount === 1 ? '' : 's'}
          <span aria-hidden>·</span>
          {formatBytes(totalSize)}
        </p>
        {dimensions && (
          <p className="truncate text-xs tabular-nums text-[var(--color-ink-faint)]">
            {dimensions}
          </p>
        )}
      </div>
    </Link>
  )
}

/** Stable hue from an id, so a model keeps the same placeholder colour. */
function hashHue(seed: string): number {
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 360
  }
  return hash
}
