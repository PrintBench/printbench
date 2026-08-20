'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, EyeOff, Loader2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { deleteFiles, removeFromLibrary } from './delete-actions'

/**
 * Removing a model.
 *
 * Two different things share the word "delete", so they are shown as two
 * different buttons with the consequence spelled out on each. The safe one is
 * first and is the only one offered for a library pointed at folders the user
 * already had — this application does not modify what it did not create.
 *
 * Deleting files asks for the model's name to be typed. That is deliberate
 * friction: it is the one irreversible action in the whole application.
 */
export function DeleteButton({
  publicId,
  name,
  libraryName,
  fileCount,
  canDeleteFiles,
}: {
  publicId: string
  name: string
  libraryName: string
  fileCount: number
  /** Only true for a library this application owns and writes to. */
  canDeleteFiles: boolean
}) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function remove() {
    setError(null)
    startTransition(async () => {
      const result = await removeFromLibrary(publicId)
      if (!result.ok) {
        setError(result.error)
        return
      }
      router.push('/models')
      router.refresh()
    })
  }

  function destroy() {
    setError(null)
    startTransition(async () => {
      const result = await deleteFiles(publicId)
      if (!result.ok) {
        setError(result.error)
        return
      }
      router.push('/models')
      router.refresh()
    })
  }

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) return
        setConfirming(false)
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
        {!confirming ? (
          <>
            <div>
              <Button variant="secondary" size="sm" disabled={pending} onClick={remove}>
                {pending ? <Loader2 className="animate-spin" /> : <EyeOff />}
                Remove from library
              </Button>
              <p className="mt-1.5 text-xs text-[var(--color-ink-muted)]">
                Forgets this model. The {fileCount} file{fileCount === 1 ? '' : 's'} stay exactly
                where they are in {libraryName}, and a scan will not bring it back. You can undo
                this from the library settings.
              </p>
            </div>

            {canDeleteFiles ? (
              <div className="border-t border-[var(--color-border)] pt-3">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-[var(--color-danger)]"
                  onClick={() => setConfirming(true)}
                >
                  <Trash2 />
                  Delete the files too
                </Button>
                <p className="mt-1.5 text-xs text-[var(--color-ink-muted)]">
                  Erases the files from disk. This cannot be undone.
                </p>
              </div>
            ) : (
              /*
               * Said plainly rather than hidden: someone looking for a delete
               * button should learn why there is only one, not wonder.
               */
              <p className="border-t border-[var(--color-border)] pt-3 text-xs text-[var(--color-ink-faint)]">
                {libraryName} holds files you already had, so this app never deletes from it. To
                remove them for good, delete the folder yourself and scan again.
              </p>
            )}
          </>
        ) : (
          <>
            <p className="flex items-start gap-2 text-sm text-[var(--color-danger)]">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              This erases {fileCount} file{fileCount === 1 ? '' : 's'} from disk. There is no undo.
            </p>
            <p className="text-xs text-[var(--color-ink-muted)]">
              Type <span className="font-medium text-[var(--color-ink)]">{name}</span> to confirm.
            </p>
            <Input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={name}
            />
            <div className="flex gap-2">
              <Button
                variant="danger"
                size="sm"
                disabled={pending || typed.trim() !== name}
                onClick={destroy}
              >
                {pending && <Loader2 className="animate-spin" />}
                Delete permanently
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </>
        )}

        {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}
      </PopoverContent>
    </Popover>
  )
}
