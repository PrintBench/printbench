'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import * as Dialog from '@radix-ui/react-dialog'
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { cn } from '@/lib/cn'
import {
  libraryRemovalChoices,
  previewLibraryFileDeletion,
  removeLibrary,
  type RemovalChoices,
} from './actions'

type Mode = 'forget' | 'delete_files' | 'move'

type Preview =
  | { state: 'loading' }
  | { state: 'error'; error: string }
  | {
      state: 'ready'
      files: number
      bytes: number
      truncated: boolean
      location: string
      nested: string[]
    }

const NUMBER = new Intl.NumberFormat('en-GB')

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

const SUBMIT: Record<Mode, string> = {
  forget: 'Remove library',
  delete_files: 'Delete files and remove',
  move: 'Move models and remove',
}

/**
 * Removing a library.
 *
 * Forgetting the index is the default and always available: the files stay
 * exactly where they are, which is the promise the rest of the application
 * makes. Saying so plainly matters here more than anywhere: "remove library"
 * reads like it could erase a folder of models someone spent years
 * collecting, and the button is unusable if people are afraid of it.
 *
 * Two more choices exist for a library PrintBench owns (an uploads library):
 * delete everything in its folder or prefix, which is how a bucket is actually
 * emptied, or move its models into another library first so nothing about
 * them is lost. Both are counted or explained before they are confirmed, and
 * both run in the worker; the row says so while they do.
 *
 * Every choice needs the library's name typed, because each one loses
 * something: at the least, the metadata the database holds and the folders
 * do not.
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
  const [open, setOpen] = useState(false)
  const [choices, setChoices] = useState<RemovalChoices | null>(null)
  const [mode, setMode] = useState<Mode>('forget')
  const [destination, setDestination] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    if (!open || choices) return
    let cancelled = false
    void libraryRemovalChoices(libraryId).then((result) => {
      if (cancelled) return
      setChoices(result)
      setDestination(result.destinations[0]?.id ?? '')
    })
    return () => {
      cancelled = true
    }
  }, [open, choices, libraryId])

  function choose(next: Mode) {
    setMode(next)
    setError(null)
    if (next !== 'delete_files' || preview) return
    setPreview({ state: 'loading' })
    void previewLibraryFileDeletion(libraryId).then((result) =>
      setPreview(result.ok ? { state: 'ready', ...result.data } : { state: 'error', ...result }),
    )
  }

  function remove() {
    setError(null)
    startTransition(async () => {
      const result = await removeLibrary(
        libraryId,
        mode === 'move' ? { mode, destinationLibraryId: destination } : { mode },
      )
      if (!result.ok) {
        setError(result.error)
        return
      }
      setOpen(false)
      router.refresh()
    })
  }

  const ready =
    typed.trim() === name &&
    (mode !== 'move' || destination !== '') &&
    (mode !== 'delete_files' || preview?.state === 'ready')

  return (
    /*
     * A centred dialog rather than a popover beside the button. The panel
     * grows once a file count or a destination picker appears, and a popover
     * anchored to a row near the top of the list grew upward off the window,
     * taking the options out of reach. A dialog is placed in the viewport,
     * not next to the row, and scrolls itself when it is taller than that.
     */
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        // Not while a request is in flight: closing would hide its answer.
        if (!next && pending) return
        setOpen(next)
        if (next) return
        setTyped('')
        setError(null)
        setMode('forget')
        setPreview(null)
        setChoices(null)
      }}
    >
      <Dialog.Trigger asChild>
        <Button variant="ghost" size="sm" title={`Remove ${name}`}>
          <Trash2 />
          <span className="hidden sm:inline">Remove</span>
        </Button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 space-y-3 overflow-y-auto rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-xl">
          <Dialog.Title className="text-base font-semibold">Remove {name}?</Dialog.Title>
          <Dialog.Description className="sr-only">
            Choose what happens to this library&apos;s files, then type its name to confirm.
          </Dialog.Description>

          <fieldset className="space-y-2" disabled={pending}>
            <legend className="sr-only">What happens to the files</legend>

            <Choice
              checked={mode === 'forget'}
              onChange={() => choose('forget')}
              title="Keep the files"
              description={
                <>
                  PrintBench forgets this library and the {NUMBER.format(modelCount)} model
                  {modelCount === 1 ? '' : 's'} it indexed. <strong>No files are deleted.</strong>
                </>
              }
            />

            <Choice
              checked={mode === 'delete_files'}
              onChange={() => choose('delete_files')}
              disabled={!choices?.canDeleteFiles}
              title="Delete the files too"
              description="Everything in this library’s folder or bucket prefix is deleted, then the library is removed. This cannot be undone."
            />

            <Choice
              checked={mode === 'move'}
              onChange={() => choose('move')}
              disabled={!choices?.canMove}
              title="Move the models to another library"
              description="Each model moves with its tags, notes, prints and share links, then this library is removed."
            />

            {choices === null ? (
              <p className="flex items-center gap-1.5 text-xs text-[var(--color-ink-faint)]">
                <Loader2 className="size-3 animate-spin" />
                Checking what this library allows…
              </p>
            ) : choices.reason ? (
              <p className="text-xs text-[var(--color-ink-faint)]">{choices.reason}</p>
            ) : !choices.canMove ? (
              <p className="text-xs text-[var(--color-ink-faint)]">
                Moving needs another uploads library to move the models into.
              </p>
            ) : null}
          </fieldset>

          {mode === 'forget' && modelCount > 0 && (
            <Warning>
              {writesSidecars
                ? 'Tags, notes and creators come back if you add the folder again and rescan, because this library writes them to a sidecar in each model folder. Anything added since the last scan may not have been written yet.'
                : 'This library does not write sidecars, so tags, notes, creators and print history are lost for good. Adding the folder again gives you the models back, but not what you recorded about them.'}
            </Warning>
          )}

          {mode === 'delete_files' && preview && (
            <div className="space-y-2 rounded-[var(--radius-control)] bg-[var(--color-danger-soft)] p-2.5 text-xs">
              {preview.state === 'loading' ? (
                <p className="flex items-center gap-1.5 text-[var(--color-ink-muted)]">
                  <Loader2 className="size-3 animate-spin" />
                  Counting the files…
                </p>
              ) : preview.state === 'error' ? (
                <p className="text-[var(--color-danger)]">{preview.error}</p>
              ) : (
                <>
                  <p className="text-[var(--color-ink)]">
                    Deletes {preview.truncated ? 'at least ' : ''}
                    <strong>
                      {NUMBER.format(preview.files)} file{preview.files === 1 ? '' : 's'} (
                      {formatBytes(preview.bytes)})
                    </strong>{' '}
                    in <span className="break-all font-mono">{preview.location}</span>, along with
                    every tag, note and print recorded for its models.
                  </p>
                  {preview.nested.length > 0 && (
                    <p className="text-[var(--color-ink-muted)]">
                      Left untouched, because another library indexes them:{' '}
                      <span className="break-all font-mono">{preview.nested.join(', ')}</span>
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          {mode === 'move' && choices && (
            <div className="space-y-1.5">
              <label htmlFor={`move-to-${libraryId}`} className="block text-xs font-medium">
                Move them into
              </label>
              <Select
                id={`move-to-${libraryId}`}
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
              >
                {choices.destinations.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-[var(--color-ink-faint)]">
                Models already missing from disk have nothing to move and are removed with the
                library. Files PrintBench never indexed stay in the old folder.
              </p>
            </div>
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

          <div className="flex justify-end gap-2 pt-1">
            <Dialog.Close asChild>
              <Button variant="ghost" size="sm" disabled={pending}>
                Cancel
              </Button>
            </Dialog.Close>
            <Button variant="danger" size="sm" disabled={pending || !ready} onClick={remove}>
              {pending && <Loader2 className="animate-spin" />}
              {SUBMIT[mode]}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Choice({
  checked,
  onChange,
  disabled,
  title,
  description,
}: {
  checked: boolean
  onChange: () => void
  disabled?: boolean
  title: string
  description: React.ReactNode
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-control)] border p-2.5',
        checked
          ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
          : 'border-[var(--color-border)]',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <input
        type="radio"
        name="removal-mode"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="mt-0.5 size-4 accent-[var(--color-accent)]"
      />
      <span className="text-xs">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-[var(--color-ink-muted)]">{description}</span>
      </span>
    </label>
  )
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-xs text-[var(--color-ink-muted)]">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[var(--color-warning)]" />
      {children}
    </p>
  )
}
