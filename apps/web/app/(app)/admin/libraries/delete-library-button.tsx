'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { deleteLibrary } from './actions'

/**
 * Removing a library.
 *
 * This deletes the index, never the files — the same promise the rest of the
 * application makes. Saying so plainly matters more here than anywhere else:
 * "delete library" reads like it could erase a folder of models someone spent
 * years collecting, and the button is unusable if people are afraid of it.
 *
 * What IS lost is metadata the database holds and the folders do not: notes,
 * tags and creators for models whose sidecar was never written. That is the
 * part worth a typed confirmation, and the part the wording leads with when
 * there is anything to lose.
 */
export function DeleteLibraryButton({
  libraryId,
  name,
  modelCount,
  writesSidecars,
}: {
  libraryId: string
  name: string
  modelCount: number
  /** Sidecars make the metadata rebuildable, which changes what is at stake. */
  writesSidecars: boolean
}) {
  const router = useRouter()
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function remove() {
    setError(null)
    startTransition(async () => {
      const result = await deleteLibrary(libraryId)
      if (!result.ok) {
        setError(result.error)
        return
      }
      router.refresh()
    })
  }

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) return
        setTyped('')
        setError(null)
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" title={`Remove ${name}`}>
          <Trash2 />
          <span className="hidden sm:inline">Remove</span>
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-80 space-y-3 p-3">
        <p className="text-sm font-medium">Remove {name}?</p>

        <p className="text-xs text-[var(--color-ink-muted)]">
          PrintBench forgets this library and the {modelCount.toLocaleString('en-GB')} model
          {modelCount === 1 ? '' : 's'} it indexed. <strong>No files are deleted</strong> — every
          one stays exactly where it is on disk.
        </p>

        {modelCount > 0 && (
          <p className="flex items-start gap-2 text-xs text-[var(--color-ink-muted)]">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[var(--color-warning)]" />
            {writesSidecars ? (
              <>
                Tags, notes and creators come back if you add the folder again and rescan, because
                this library writes them to a sidecar in each model folder. Anything added since the
                last scan may not have been written yet.
              </>
            ) : (
              <>
                This library does not write sidecars, so tags, notes, creators and print history are
                lost for good. Adding the folder again gives you the models back, but not what you
                recorded about them.
              </>
            )}
          </p>
        )}

        <p className="text-xs text-[var(--color-ink-muted)]">
          Type <span className="font-medium text-[var(--color-ink)]">{name}</span> to confirm.
        </p>
        <Input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={name}
          aria-label={`Type ${name} to confirm`}
        />

        {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}

        <Button
          variant="danger"
          size="sm"
          disabled={pending || typed.trim() !== name}
          onClick={remove}
        >
          {pending && <Loader2 className="animate-spin" />}
          Remove library
        </Button>
      </PopoverContent>
    </Popover>
  )
}
