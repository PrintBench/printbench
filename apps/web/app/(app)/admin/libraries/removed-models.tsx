'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { restore } from '../../models/[publicId]/delete-actions'

/**
 * Models removed from a library, and the way back.
 *
 * This is the undo for "remove from library". Restoring only lifts the
 * exclusion — the model itself is rebuilt by the next scan from the files and
 * its sidecar, so anything typed into the app and never written to a sidecar
 * is genuinely gone. Worth saying, rather than letting "restore" imply more
 * than it does.
 */

export interface RemovedModel {
  libraryId: string
  libraryName: string
  path: string
  name: string | null
  excludedAt: string
}

export function RemovedModels({ removed }: { removed: RemovedModel[] }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  if (removed.length === 0) return null

  return (
    <Card className="mt-6">
      <CardContent className="p-4">
        <h2 className="text-sm font-semibold">Removed models</h2>
        <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">
          Forgotten, but still on disk. Restoring brings one back at the next scan of its library —
          rebuilt from the files and its sidecar, so notes and tags return only if they were written
          to one.
        </p>

        {error && <p className="mt-2 text-xs text-[var(--color-danger)]">{error}</p>}

        <ul className="mt-3 divide-y divide-[var(--color-border)]">
          {removed.map((entry) => (
            <li key={`${entry.libraryId}:${entry.path}`} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{entry.name ?? entry.path}</p>
                <p className="truncate font-mono text-xs text-[var(--color-ink-faint)]">
                  {entry.libraryName} · {entry.path}
                </p>
              </div>
              <span className="shrink-0 text-xs text-[var(--color-ink-faint)]">
                {new Date(entry.excludedAt).toLocaleDateString('en-GB', {
                  day: 'numeric',
                  month: 'short',
                })}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => {
                  setError(null)
                  startTransition(async () => {
                    const result = await restore(entry.libraryId, entry.path)
                    if (!result.ok) setError(result.error)
                    else router.refresh()
                  })
                }}
              >
                {pending ? <Loader2 className="animate-spin" /> : <Undo2 />}
                Restore
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
