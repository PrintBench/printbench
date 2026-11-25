'use client'
import { useEffect, useId, useRef, useState, useTransition } from 'react'
import { Loader2, Search, X } from 'lucide-react'
import type { CatalogPick } from '@pb/core/filaments'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Swatch } from '@/components/filament/swatch'
import { formatValue, formatWeight } from '@/components/filament/format'
import { findInCatalog } from './actions'

/**
 * "Find in catalogue" for the spool form. Searching runs on the server against
 * the bundled catalogue in Postgres, so it works offline. Picking fills in the
 * form; nothing is saved until the form is.
 */
export function CatalogPicker({
  pick,
  sizeUuid,
  onPick,
  onSize,
  onClear,
}: {
  pick: CatalogPick | null
  sizeUuid: string | null
  onPick: (pick: CatalogPick) => void
  onSize: (sizeUuid: string | null) => void
  onClear: () => void
}) {
  const id = useId()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<CatalogPick[]>([])
  const [searched, setSearched] = useState('')
  const [pending, startTransition] = useTransition()
  const latest = useRef('')

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length < 2) return
    const timer = setTimeout(() => {
      latest.current = trimmed
      startTransition(async () => {
        const found = await findInCatalog(trimmed)
        // Drop a response that arrives after the user has typed on.
        if (latest.current !== trimmed) return
        setResults(found)
        setSearched(trimmed)
      })
    }, 250)
    return () => clearTimeout(timer)
  }, [query])

  const showResults = query.trim().length >= 2 && searched === query.trim()

  if (pick) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius-control)] border border-[var(--color-accent)] bg-[var(--color-accent-soft)] p-3">
        <Swatch colorHex={pick.colorHex} className="size-8" />
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">
            {pick.brandName} {pick.filamentName} — {pick.variantName}
          </p>
          <p className="text-[var(--color-ink-muted)]">
            Filled in from the catalogue. Change anything below before saving.
          </p>
        </div>
        {pick.sizes.length > 0 && (
          <Select
            aria-label="Spool size"
            value={sizeUuid ?? ''}
            onChange={(e) => onSize(e.target.value || null)}
            className="w-auto"
          >
            <option value="">Any spool size</option>
            {pick.sizes.map((s) => (
              <option key={s.uuid} value={s.uuid}>
                {[
                  formatWeight(s.filamentWeightG),
                  formatValue(s.diameterMm, 'mm'),
                  s.spoolRefill && 'refill',
                  s.discontinued && 'discontinued',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </option>
            ))}
          </Select>
        )}
        <button
          type="button"
          onClick={onClear}
          className="text-sm text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
        >
          Clear
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium">
        Find in catalogue{' '}
        <span className="font-normal text-[var(--color-ink-muted)]">(optional)</span>
      </label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--color-ink-faint)]" />
        <Input
          id={id}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. Prusament PETG Galaxy Black"
          autoComplete="off"
          className="pl-9 pr-9"
          aria-controls={`${id}-results`}
        />
        {pending ? (
          <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-[var(--color-ink-faint)]" />
        ) : (
          query && (
            <button
              type="button"
              aria-label="Clear catalogue search"
              onClick={() => setQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
            >
              <X className="size-4" />
            </button>
          )
        )}
      </div>
      {showResults && (
        <ul
          id={`${id}-results`}
          aria-label="Catalogue matches"
          className="max-h-72 overflow-y-auto rounded-[var(--radius-control)] border border-[var(--color-border)]"
        >
          {results.length === 0 ? (
            <li className="p-3 text-sm text-[var(--color-ink-muted)]">
              Nothing in the catalogue matches. Fill in the details by hand below.
            </li>
          ) : (
            results.map((r) => (
              <li key={r.variantUuid}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(r)
                    setQuery('')
                  }}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-[var(--color-surface-2)] focus:bg-[var(--color-surface-2)]"
                >
                  <Swatch colorHex={r.colorHex} className="size-6" />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{r.variantName}</span>
                    <span className="text-[var(--color-ink-muted)]">
                      {' '}
                      · {r.brandName} {r.filamentName}
                    </span>
                  </span>
                  <span className="text-xs text-[var(--color-ink-muted)]">
                    {r.material}
                    {r.discontinued && ' · discontinued'}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  )
}
