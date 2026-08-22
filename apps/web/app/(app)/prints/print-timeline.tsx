import Link from 'next/link'
import { CheckCircle2, CircleDashed, Loader2, XCircle } from 'lucide-react'
import type { PrintStatus } from '@pb/core'
import { cn } from '@/lib/cn'

/**
 * The library-wide print log.
 *
 * A server component: nothing here is interactive. Editing a print happens on
 * the model page, where the rest of its context is — a global list is for
 * seeing what has been coming off the plate, not for correcting it.
 */

export interface TimelinePrint {
  id: string
  modelName: string
  modelPublicId: string
  filename: string | null
  userName: string | null
  printerName: string | null
  material: string | null
  colorHex: string | null
  layerHeightMm: number | null
  nozzleMm: number | null
  status: PrintStatus
  durationMin: number | null
  filamentUsedG: number | null
  rating: number | null
  notes: string | null
  at: string
}

const STATUS_META: Record<
  PrintStatus,
  { label: string; icon: typeof CheckCircle2; class: string }
> = {
  success: { label: 'Success', icon: CheckCircle2, class: 'text-[var(--color-success)]' },
  failed: { label: 'Failed', icon: XCircle, class: 'text-[var(--color-danger)]' },
  partial: { label: 'Partial', icon: CircleDashed, class: 'text-[var(--color-warning)]' },
  in_progress: { label: 'Printing', icon: Loader2, class: 'text-[var(--color-accent)]' },
}

export function PrintTimeline({ prints }: { prints: TimelinePrint[] }) {
  return (
    <ol className="divide-y divide-[var(--color-border)]">
      {prints.map((print) => {
        const meta = STATUS_META[print.status]
        const Icon = meta.icon

        const settings = [
          print.printerName,
          print.material,
          print.layerHeightMm != null && `${print.layerHeightMm} mm layers`,
          print.nozzleMm != null && `${print.nozzleMm} mm nozzle`,
          print.durationMin != null && formatDuration(print.durationMin),
          print.filamentUsedG != null && formatGrams(print.filamentUsedG),
        ].filter(Boolean) as string[]

        return (
          <li key={print.id} className="flex gap-3 px-4 py-3">
            <Icon
              aria-hidden
              className={cn(
                'mt-0.5 size-4 shrink-0',
                meta.class,
                print.status === 'in_progress' && 'animate-spin',
              )}
            />

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <Link
                  href={`/models/${print.modelPublicId}`}
                  className="truncate text-sm font-medium hover:underline"
                >
                  {print.modelName}
                </Link>
                <span className="text-xs text-[var(--color-ink-faint)]">{meta.label}</span>
                {print.rating != null && (
                  <span
                    className="text-xs text-[var(--color-warning)]"
                    aria-label={`Rated ${print.rating} out of 5`}
                  >
                    {'★'.repeat(print.rating)}
                  </span>
                )}
                {print.colorHex && (
                  <span
                    title={print.colorHex}
                    className="size-3 rounded-full ring-1 ring-inset ring-[var(--color-border)]"
                    style={{ backgroundColor: print.colorHex }}
                  />
                )}
              </div>

              {settings.length > 0 && (
                <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">
                  {settings.join(' · ')}
                </p>
              )}
              {print.notes && (
                <p className="mt-1 line-clamp-2 text-sm text-[var(--color-ink-muted)]">
                  {print.notes}
                </p>
              )}
            </div>

            <div className="shrink-0 text-right">
              <p className="text-xs text-[var(--color-ink-faint)]">{formatDate(print.at)}</p>
              {print.userName && (
                <p className="text-xs text-[var(--color-ink-faint)]">{print.userName}</p>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

function formatGrams(grams: number): string {
  return grams >= 1000 ? `${(grams / 1000).toFixed(2)} kg` : `${Math.round(grams)} g`
}
