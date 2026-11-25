import { cn } from '@/lib/cn'

const HEX = /^#[0-9a-f]{6}$/i

/**
 * A filament colour dot. Multi-colour filament (silk duals, gradients) shows
 * its colours as a conic split.
 *
 * Colours are checked again here even though the catalogue validates them:
 * the value goes into a style attribute, and owned filament colours are typed
 * by hand.
 */
export function Swatch({
  colorHex,
  colorHexes = [],
  title,
  className,
}: {
  colorHex: string | null
  colorHexes?: string[]
  title?: string
  className?: string
}) {
  const colours = [colorHex, ...colorHexes].filter((c): c is string => !!c && HEX.test(c))
  const unique = [...new Set(colours.map((c) => c.toLowerCase()))]
  const background =
    unique.length === 0
      ? 'var(--color-surface-2)'
      : unique.length === 1
        ? unique[0]
        : `conic-gradient(${unique
            .map(
              (c, i) =>
                `${c} ${(i / unique.length) * 360}deg ${((i + 1) / unique.length) * 360}deg`,
            )
            .join(', ')})`
  return (
    <span
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      title={title}
      className={cn(
        'inline-block shrink-0 rounded-full border border-[var(--color-border)]',
        className,
      )}
      style={{ background }}
    />
  )
}

/** A bundled brand or store logo, or its initials when there is none. */
export function CatalogLogo({
  path,
  name,
  className,
}: {
  path: string | null
  name: string
  className?: string
}) {
  // Only our own bundled paths: logos are written by `npm run filaments:update`.
  if (path && path.startsWith('/filament-catalog/')) {
    return (
      // Plain img: logos are already downscaled WebP files served from /public.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={path}
        alt=""
        loading="lazy"
        decoding="async"
        className={cn('object-contain', className)}
      />
    )
  }
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('')
  return (
    <span
      aria-hidden
      className={cn(
        'flex items-center justify-center rounded-md bg-[var(--color-surface-2)] text-xs font-semibold text-[var(--color-ink-muted)]',
        className,
      )}
    >
      {initials}
    </span>
  )
}
