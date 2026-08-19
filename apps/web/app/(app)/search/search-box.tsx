'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Search, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { buildHref, type RawParams } from './params'

const SORTS: { value: string; label: string }[] = [
  { value: 'relevance', label: 'Best match' },
  { value: 'name', label: 'Name' },
  { value: 'recent', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'largest', label: 'Largest' },
]

/**
 * The search input.
 *
 * Typing navigates, after a pause. Pushing the query into the URL rather than
 * holding it in component state is what makes results shareable and the back
 * button work, and it keeps rendering on the server where the data already is.
 *
 * 250 ms is the debounce: long enough that a normal typing burst is one
 * request, short enough to feel immediate.
 */
export function SearchBox({ initialQuery, params }: { initialQuery: string; params: RawParams }) {
  const router = useRouter()
  const [value, setValue] = useState(initialQuery)
  const [pending, startTransition] = useTransition()
  const inputRef = useRef<HTMLInputElement>(null)
  const latest = useRef(initialQuery)

  // Keep in step when navigation changes the query from outside — a facet
  // link, the back button, or the command palette.
  useEffect(() => {
    setValue(initialQuery)
    latest.current = initialQuery
  }, [initialQuery])

  useEffect(() => {
    if (value === latest.current) return
    const timer = setTimeout(() => {
      latest.current = value
      startTransition(() => {
        router.push(buildHref(params, { q: value || null }))
      })
    }, 250)
    return () => clearTimeout(timer)
  }, [value, params, router])

  // "/" focuses search, the convention everywhere else.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA'
      if (event.key === '/' && !typing) {
        event.preventDefault()
        inputRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const sort = (Array.isArray(params.sort) ? params.sort[0] : params.sort) ?? 'relevance'

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative min-w-0 flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--color-ink-faint)]" />
        <input
          ref={inputRef}
          type="search"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Search models, creators, tags and filenames…"
          aria-label="Search"
          className={cn(
            'h-11 w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] pl-9 pr-9 text-sm',
            'placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-accent)]',
          )}
        />
        {pending ? (
          <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-[var(--color-ink-faint)]" />
        ) : (
          value.length > 0 && (
            <button
              type="button"
              onClick={() => setValue('')}
              aria-label="Clear search"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
            >
              <X className="size-4" />
            </button>
          )
        )}
      </div>

      <label className="flex items-center gap-2 text-sm text-[var(--color-ink-muted)]">
        Sort
        <select
          value={sort}
          onChange={(event) =>
            router.push(buildHref(params, { sort: event.target.value }))
          }
          className="h-9 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-ink)]"
        >
          {SORTS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
