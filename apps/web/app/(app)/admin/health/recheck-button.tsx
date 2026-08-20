'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { recheck } from './actions'

/**
 * Re-examines on demand.
 *
 * Health is checked after every scan and again overnight, so this is for the
 * case where you have just fixed a batch and want to watch them disappear.
 */
export function RecheckButton() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [note, setNote] = useState<string | null>(null)

  return (
    <div className="flex items-center gap-3">
      {note && <span className="text-xs text-[var(--color-ink-muted)]">{note}</span>}
      <Button
        variant="secondary"
        size="sm"
        disabled={pending}
        onClick={() => {
          setNote(null)
          startTransition(async () => {
            const result = await recheck()
            setNote(
              result.ok
                ? result.count
                  ? `${result.count} change${result.count === 1 ? '' : 's'}`
                  : 'No change'
                : result.error,
            )
            router.refresh()
          })
        }}
      >
        {pending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        Check again
      </Button>
    </div>
  )
}
