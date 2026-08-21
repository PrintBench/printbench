'use client'

import { useId } from 'react'
import { cn } from '@/lib/cn'

/**
 * The PrintBench mark.
 *
 * A "P" drawn as four parallel strokes, the way an extruder lays down a
 * perimeter and its shells — which is the whole idea of the logo, so it is
 * built as a real concentric offset rather than four hand-placed curves.
 *
 * That means one thing has to hold: the bowl's arc CENTRE is fixed and only
 * its radius steps inward. Offsetting a curve by moving its start and end
 * points instead makes the strokes drift out of parallel around the turn,
 * which is exactly where the eye notices.
 *
 * The stems end on a stagger rather than square, giving the mark the fanned
 * bottom-left the brand sheet has.
 *
 * A client component only because the gradient needs an id unique per
 * instance (`useId` is a hook). Two marks on one page sharing an id would
 * both resolve to whichever was rendered first, so the second would break the
 * moment the first unmounted — a bug that only appears on a page nobody
 * tested with two logos.
 */

/** Arc centre. Shared by every stroke — see above. */
const CX = 62
const CY = 51
/**
 * Outermost bowl radius, stepping in by GAP per stroke.
 *
 * GAP is comfortably wider than STROKE so the negative space between the
 * shells stays legible: closed up, the four lines read as one thick mass and
 * the layer-line idea is lost, which is the whole point of the mark.
 */
const R = 39
const GAP = 12
const STROKE = 7

const STROKES = [0, 1, 2, 3].map((i) => {
  const r = R - i * GAP
  const stemX = 16 + i * GAP
  const topY = CY - r
  const bowlBottomY = CY + r
  // Outer stems run deepest, so the ends fan rather than line up square.
  const stemBottomY = 116 - i * 6

  return [
    `M${stemX},${stemBottomY}`,
    `L${stemX},${topY}`,
    `L${CX},${topY}`,
    `A${r},${r} 0 0 1 ${CX},${bowlBottomY}`,
    `L${stemX},${bowlBottomY}`,
  ].join(' ')
})

export function PrintBenchMark({ className }: { className?: string }) {
  // Unique per instance: two marks on one page would otherwise share a
  // gradient id, and the second would silently reference the first.
  const gradientId = useId()

  return (
    <svg
      viewBox="0 0 107 128"
      fill="none"
      role="img"
      aria-label="PrintBench"
      className={className}
    >
      <defs>
        {/* Blue at the foot rising to teal at the bowl, as on the brand sheet. */}
        <linearGradient id={gradientId} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="#1B7FDB" />
          <stop offset="100%" stopColor="#2BBF9C" />
        </linearGradient>
      </defs>

      {STROKES.map((d) => (
        <path
          key={d}
          d={d}
          stroke={`url(#${gradientId})`}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  )
}

/**
 * Mark plus wordmark.
 *
 * "Print" takes the surrounding ink colour so it works on either theme;
 * "Bench" is fixed to the brand cyan, which is the one piece of colour the
 * identity keeps constant across the light and dark lockups.
 */
export function PrintBenchLogo({
  className,
  tagline = false,
}: {
  className?: string
  tagline?: boolean
}) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <PrintBenchMark className="h-[1.65em] w-auto shrink-0" />
      <span className="flex flex-col leading-none">
        <span className="text-[1.05em] font-semibold tracking-tight">
          Print<span className="text-[var(--color-accent)]">Bench</span>
        </span>
        {tagline && (
          <span className="mt-1 text-[0.5em] font-normal text-[var(--color-ink-muted)]">
            Your 3D printing workspace
          </span>
        )}
      </span>
    </span>
  )
}
