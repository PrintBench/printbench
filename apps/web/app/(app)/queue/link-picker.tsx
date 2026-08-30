'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { Link2, Link2Off, Loader2, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { findModels, type ModelChoice } from './actions'

/**
 * Attaches a request to a model in the library.
 *
 * The queue is deliberately usable with nothing linked — most requests arrive
 * before anyone has looked for the file. This is the other half of that: when
 * the file does turn up, pointing the request at it should take one search and
 * one click, not a re-typed entry.
 */
export function LinkPicker({
  linkedName,
  suggestQuery,
  onLink,
  pending,
}: {
  linkedName: string | null
  /** The request's own title — the obvious first thing to search for. */
  suggestQuery: string
  onLink: (modelId: string | null) => void
  pending: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState(suggestQuery)
  const [results, setResults] = useState<ModelChoice[]>([])
  const [searching, startSearch] = useTransition()

  /*
   * The result of the newest keystroke, not of the newest response. Search
   * responses arrive out of order often enough that without this the list can
   * settle on the answer to a prefix the user has already typed past.
   */
  const latest = useRef(0)

  useEffect(() => {
    if (!open) return

    const term = query.trim()
    if (term.length < 2) return

    // Debounced: the picker searches as you type, and every keystroke hitting
    // the database is a lot of round trips for a field that changes fast.
    const handle = setTimeout(() => {
      const ticket = ++latest.current
      startSearch(async () => {
        const hits = await findModels(term)
        if (ticket === latest.current) setResults(hits)
      })
    }, 200)

    return () => clearTimeout(handle)
  }, [query, open])

  /*
   * Derived rather than cleared from the effect: a query too short to search
   * has no results by definition, and computing that is both simpler than an
   * extra setState and free of the render cascade one would cause.
   */
  const visible = query.trim().length >= 2 ? results : []

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        // Reopening starts from the title again rather than from whatever was
        // typed last time, which by then is usually about a different request.
        if (next) setQuery(suggestQuery)
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          // The label is hidden on a narrow screen, so name the button outright
          // rather than leaving a bare icon.
          aria-label={linkedName ? `Change the link from ${linkedName}` : 'Link to library'}
        >
          <Link2 />
          <span className="hidden sm:inline">{linkedName ? 'Change link' : 'Link to library'}</span>
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-80 p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-[var(--color-ink-faint)]" />
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search your library"
            className="h-9 pl-8"
          />
        </div>

        <div className="mt-2 max-h-64 overflow-y-auto">
          {searching && visible.length === 0 && (
            <p className="flex items-center gap-2 px-2 py-3 text-xs text-[var(--color-ink-muted)]">
              <Loader2 className="size-3.5 animate-spin" />
              Searching
            </p>
          )}

          {!searching && query.trim().length >= 2 && visible.length === 0 && (
            <p className="px-2 py-3 text-xs text-[var(--color-ink-muted)]">
              Nothing in the library matches that. The request can stay unlinked until the file
              exists.
            </p>
          )}

          {query.trim().length < 2 && (
            <p className="px-2 py-3 text-xs text-[var(--color-ink-faint)]">
              Type at least two characters.
            </p>
          )}

          {visible.map((model) => (
            <button
              key={model.id}
              type="button"
              onClick={() => {
                onLink(model.id)
                setOpen(false)
              }}
              className="flex w-full flex-col items-start gap-0.5 rounded-[var(--radius-control)] px-2 py-1.5 text-left hover:bg-[var(--color-surface-2)]"
            >
              <span className="w-full truncate text-sm">{model.name}</span>
              {model.libraryName && (
                <span className="w-full truncate text-xs text-[var(--color-ink-faint)]">
                  {model.libraryName}
                </span>
              )}
            </button>
          ))}
        </div>

        {linkedName && (
          <div className="mt-1 border-t border-[var(--color-border)] pt-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onLink(null)
                setOpen(false)
              }}
            >
              <Link2Off />
              Unlink from {linkedName}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
