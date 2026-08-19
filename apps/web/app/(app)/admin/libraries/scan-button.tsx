'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { triggerScan } from './actions'

export function ScanButton({
  libraryId,
  needsConfirmation,
}: {
  libraryId: string
  needsConfirmation?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  function run(options: { mode?: 'fast' | 'deep'; force?: boolean } = {}) {
    setMessage(null)
    setConfirming(false)
    startTransition(async () => {
      const result = await triggerScan(libraryId, options)
      setMessage(result.ok ? 'Scan queued' : result.error)
      router.refresh()
    })
  }

  /*
   * A previous scan refused to proceed because too much would have disappeared.
   * Re-running normally would just abort again, so the only way forward is an
   * explicit confirmation — deliberately a two-step, destructive-looking action.
   */
  if (needsConfirmation) {
    return (
      <div className="flex flex-col items-end gap-2">
        {confirming ? (
          <div className="flex flex-col items-end gap-2 rounded-[var(--radius-control)] border border-[var(--color-danger)] bg-[var(--color-danger-soft)] p-3">
            <p className="max-w-xs text-right text-xs text-[var(--color-ink)]">
              Only confirm if you really did delete those models. If a drive or
              network share is unmounted, fix that first — confirming will mark
              everything on it as missing.
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button size="sm" variant="danger" disabled={pending} onClick={() => run({ force: true })}>
                Yes, they were deleted
              </Button>
            </div>
          </div>
        ) : (
          <>
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => run()}>
              <RefreshCw className={pending ? 'animate-spin' : undefined} />
              Retry scan
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
              <AlertTriangle />
              Confirm deletion
            </Button>
          </>
        )}
        {message && <span className="text-xs text-[var(--color-ink-faint)]">{message}</span>}
      </div>
    )
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => run({ mode: 'fast' })}>
          <RefreshCw className={pending ? 'animate-spin' : undefined} />
          Scan
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          title="Re-examines every file. Slower, but catches edits to existing files."
          onClick={() => run({ mode: 'deep' })}
        >
          Deep scan
        </Button>
      </div>
      {message && <span className="text-xs text-[var(--color-ink-faint)]">{message}</span>}
    </div>
  )
}
