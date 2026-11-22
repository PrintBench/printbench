'use client'

import { useState, useTransition } from 'react'
import { ArrowUpCircle, Check, CircleAlert, Loader2 } from 'lucide-react'
import type { UpdateStatus } from '@pb/core'
import { Button } from '@/components/ui/button'
import { LocalTime } from '@/components/ui/local-time'
import { checkForUpdateNow } from './actions'

/**
 * What this instance is running, and whether anything newer exists.
 *
 * Deliberately shows the installed version even when the check is off: "which
 * version am I on?" is the question someone asks before filing a bug, and it
 * should not depend on an outbound request having worked.
 */
export function UpdateStatusPanel({
  initial,
  enabled,
}: {
  initial: UpdateStatus | null
  enabled: boolean
}) {
  const [status, setStatus] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const version = status?.currentVersion ?? process.env.NEXT_PUBLIC_APP_VERSION ?? 'unknown'

  function check() {
    setError(null)
    startTransition(async () => {
      const result = await checkForUpdateNow()
      if (!result.ok) {
        setError(result.error)
        return
      }
      setStatus(result.status)
    })
  }

  return (
    <div className="space-y-3 rounded-[var(--radius-control)] border border-[var(--color-border)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">This instance runs PrintBench {version}</p>
          {!enabled ? (
            <p className="text-xs text-[var(--color-ink-faint)]">
              Version checks are turned off, so nothing is compared against the released version.
            </p>
          ) : status?.updateAvailable && status.latestVersion ? (
            <p className="flex items-center gap-1.5 text-xs text-[var(--color-accent)]">
              <ArrowUpCircle className="size-3.5 shrink-0" />
              <span>
                PrintBench {status.latestVersion} is available.{' '}
                {status.releaseUrl && (
                  <a
                    className="underline"
                    href={status.releaseUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    Release notes
                  </a>
                )}
              </span>
            </p>
          ) : status?.latestVersion ? (
            <p className="flex items-center gap-1.5 text-xs text-[var(--color-success)]">
              <Check className="size-3.5 shrink-0" />
              This is the latest release.
            </p>
          ) : (
            <p className="text-xs text-[var(--color-ink-faint)]">
              The released version has not been read yet.
            </p>
          )}
          {/* A failed check keeps the last version it did read, so say which it is. */}
          {enabled && status?.failed && (
            <p className="flex items-center gap-1.5 text-xs text-[var(--color-ink-muted)]">
              <CircleAlert className="size-3.5 shrink-0 text-[var(--color-danger)]" />
              The last check could not reach the release feed.
            </p>
          )}
          {status?.checkedAt && (
            <p className="text-xs text-[var(--color-ink-faint)]">
              Last read <LocalTime value={status.checkedAt} />
            </p>
          )}
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={check} disabled={pending}>
          {pending && <Loader2 className="animate-spin" />}
          Check now
        </Button>
      </div>
      {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}
    </div>
  )
}
