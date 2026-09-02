'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Cloud, FolderInput, HardDrive, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { currentLibrary, listMoveTargets, moveToLibrary, type MoveTarget } from './move-actions'

/**
 * Moving a model to another library.
 *
 * The fix for uploading to the wrong one, which otherwise means deleting the
 * model and uploading it again — losing its tags, notes, collections, print
 * history and share link on the way. So the panel says what comes with it:
 * the reason to use this rather than the obvious workaround is exactly what a
 * user cannot see from the outside.
 *
 * The move itself runs in the worker, so this waits by asking where the model
 * is until the answer changes. A local move finishes almost at once; one
 * between backends copies every byte and genuinely takes a while.
 */
/** Half-second polls first, covering a same-disk move that lands immediately. */
const QUICK_POLLS = 10
/** Then three-second ones, to a little over ten minutes in total. */
const MAX_POLLS = 210

export function MoveButton({
  publicId,
  name,
  libraryName,
}: {
  publicId: string
  name: string
  libraryName: string
}) {
  const router = useRouter()
  const [targets, setTargets] = useState<MoveTarget[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [moving, setMoving] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => clearTimeout(timer.current ?? undefined), [])

  function load(open: boolean) {
    setError(null)
    if (!open) return
    // Fetched on open rather than with the page: most visits never touch this,
    // and the answer includes a path collision check per library.
    startTransition(async () => setTargets(await listMoveTargets(publicId)))
  }

  function move(target: MoveTarget) {
    setError(null)
    setMoving(target.id)

    startTransition(async () => {
      const result = await moveToLibrary(publicId, target.id)
      if (!result.ok) {
        setError(result.error)
        setMoving(null)
        return
      }
      poll(target.id, 0)
    })
  }

  /*
   * Asks where the model is until it is where it was sent.
   *
   * Polling rather than a progress stream because there is one thing worth
   * knowing — whether it landed — and a job-progress channel for a single
   * boolean would be a lot of machinery to maintain. Slows down after the
   * first few seconds so a cross-backend move is not a request every half
   * second for ten minutes, and gives up rather than spinning forever: the
   * move continues in the worker either way, and a reload will show it.
   *
   * Counting attempts rather than watching the clock keeps this callable from
   * a render path without reaching for `Date.now`.
   */
  function poll(destinationId: string, attempt: number) {
    if (attempt >= MAX_POLLS) {
      setMoving(null)
      setError('This is taking a while. It is still running — reload to see where it got to.')
      return
    }

    timer.current = setTimeout(
      () => {
        void currentLibrary(publicId).then((libraryId) => {
          if (libraryId === destinationId) {
            setMoving(null)
            router.refresh()
            return
          }
          poll(destinationId, attempt + 1)
        })
      },
      attempt < QUICK_POLLS ? 500 : 3000,
    )
  }

  return (
    <Popover onOpenChange={load}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" title={`Move ${name} to another library`}>
          <FolderInput />
          <span className="hidden sm:inline">Move</span>
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-80 space-y-3 p-3">
        <div>
          <p className="text-sm font-medium">Move to another library</p>
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            Currently in {libraryName}. The files move; its tags, notes, collections, print history
            and share link stay with it.
          </p>
        </div>

        {targets === null ? (
          <p className="flex items-center gap-2 text-xs text-[var(--color-ink-muted)]">
            <Loader2 className="size-3 animate-spin" />
            Looking for libraries…
          </p>
        ) : targets.length === 0 ? (
          /*
           * Said plainly. The usual cause is having only one library that can
           * be written to, which is not obvious from a panel showing nothing.
           */
          <p className="text-xs text-[var(--color-ink-faint)]">
            There is nowhere to move it to. A library can only receive a model if this app owns it,
            or if writes were turned on for it.
          </p>
        ) : (
          <ul className="space-y-1">
            {targets.map((target) => (
              <li key={target.id}>
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full justify-start"
                  disabled={pending || moving !== null || target.occupied}
                  onClick={() => move(target)}
                >
                  {moving === target.id ? (
                    <Loader2 className="animate-spin" />
                  ) : target.backend === 's3' ? (
                    <Cloud />
                  ) : (
                    <HardDrive />
                  )}
                  <span className="truncate">{target.name}</span>
                </Button>
                {target.occupied && (
                  // Told here rather than as an error after choosing: the fix
                  // is to rename one of them, which is a different job.
                  <p className="mt-0.5 px-1 text-xs text-[var(--color-ink-faint)]">
                    Something is already at this model&rsquo;s path there.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}

        {moving && (
          <p className="text-xs text-[var(--color-ink-muted)]">
            Moving. A move between two libraries on the same disk is quick; one that has to copy
            every byte takes as long as the files are big.
          </p>
        )}

        {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}
      </PopoverContent>
    </Popover>
  )
}
