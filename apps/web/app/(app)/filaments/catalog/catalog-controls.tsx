'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Search, X } from 'lucide-react'
import type { CatalogFacets } from '@pb/core'
import { Select } from '@/components/ui/select'
import { cn } from '@/lib/cn'
import { catalogHref, type RawParams } from './params'

/**
 * Search box and filters for the catalogue. Every change navigates, so the
 * state lives in the URL and the server renders the results; typing is
 * debounced 250 ms, the same as model search.
 */
export function CatalogControls({
  params,
  facets,
  initialQuery,
}: {
  params: RawParams
  facets: CatalogFacets
  initialQuery: string
}) {
  const router = useRouter()
  const [value, setValue] = useState(initialQuery)
  const [pending, startTransition] = useTransition()
  const latest = useRef(initialQuery)

  // Keep in step when navigation changes the query from outside (back button).
  useEffect(() => {
    setValue(initialQuery)
    latest.current = initialQuery
  }, [initialQuery])

  useEffect(() => {
    if (value === latest.current) return
    const timer = setTimeout(() => {
      latest.current = value
      startTransition(() => router.push(catalogHref(params, { q: value || null })))
    }, 250)
    return () => clearTimeout(timer)
  }, [value, params, router])

  const go = (changes: Record<string, string | null>) =>
    startTransition(() => router.push(catalogHref(params, changes)))
  const current = (key: string) => {
    const v = params[key]
    return (Array.isArray(v) ? v[0] : v) ?? ''
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--color-ink-faint)]" />
        <input
          type="search"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Search brand, product, material or colour…"
          aria-label="Search the filament catalogue"
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
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Select
          aria-label="Filter brand"
          value={current('brand')}
          onChange={(e) => go({ brand: e.target.value || null })}
        >
          <option value="">All brands</option>
          {facets.brands.map((b) => (
            <option key={b.uuid} value={b.uuid}>
              {b.name} ({b.count})
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filter material"
          value={current('material')}
          onChange={(e) => go({ material: e.target.value || null })}
        >
          <option value="">All materials</option>
          {facets.materials.map((m) => (
            <option key={m.value} value={m.value}>
              {m.value} ({m.count})
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filter diameter"
          value={current('diameter')}
          onChange={(e) => go({ diameter: e.target.value || null })}
        >
          <option value="">Any diameter</option>
          {facets.diameters.map((d) => (
            <option key={d.value} value={String(d.value)}>
              {d.value} mm ({d.count})
            </option>
          ))}
        </Select>
        <label className="flex h-10 items-center gap-2 text-sm text-[var(--color-ink-muted)]">
          <input
            type="checkbox"
            checked={current('discontinued') === '1'}
            onChange={(e) => go({ discontinued: e.target.checked ? '1' : null })}
            className="size-4 accent-[var(--color-accent)]"
          />
          Include discontinued
        </label>
      </div>
    </div>
  )
}
