import { FlaskConical } from 'lucide-react'
import { nextDemoReset } from '@pb/core'

/**
 * Tells a demo visitor that what they change is temporary.
 *
 * Rendered on the server for every page, so the countdown is right at the
 * moment the page was loaded; it does not tick, which is fine for something
 * measured in hours and saves a client component on every page.
 */
export function DemoBanner({ now = new Date() }: { now?: Date }) {
  const minutes = Math.max(1, Math.round((nextDemoReset(now).getTime() - now.getTime()) / 60_000))
  const hours = Math.floor(minutes / 60)
  const left = hours > 0 ? `${hours} h ${minutes % 60} m` : `${minutes} m`

  return (
    <div
      role="note"
      className="mb-6 flex items-start gap-3 rounded-lg bg-[var(--color-accent-soft)] px-4 py-3 text-sm text-[var(--color-ink)]"
    >
      <FlaskConical className="mt-0.5 size-4 shrink-0 text-[var(--color-accent)]" aria-hidden />
      <p>
        <span className="font-medium">You&apos;re exploring the PrintBench demo.</span> Upload, edit
        and rearrange whatever you like: everything goes back to how it started at midnight UTC (in{' '}
        {left}).
      </p>
    </div>
  )
}
