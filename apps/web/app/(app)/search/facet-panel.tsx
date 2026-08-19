import Link from 'next/link'
import { Check, X } from 'lucide-react'
import type { SearchFacets } from '@pm/core'
import { cn } from '@/lib/cn'
import { buildHref, toggleHref, type ParsedSearchParams, type RawParams } from './params'

const NUMBER = new Intl.NumberFormat('en-GB')

/**
 * Faceted filters.
 *
 * Every option is a plain link, so filtering works without JavaScript, the back
 * button behaves, and each combination is a real URL that can be shared. The
 * counts come from the search itself and exclude the facet's own filter, so
 * ticking one creator still shows how many models the others have.
 */
export function FacetPanel({
  facets,
  params,
  raw,
}: {
  facets: SearchFacets
  params: ParsedSearchParams
  raw: RawParams
}) {
  const groups: { key: string; title: string; options: { value: string; label: string; count: number }[]; selected: string[] }[] = [
    { key: 'library', title: 'Library', options: facets.libraries, selected: params.library },
    { key: 'creator', title: 'Creator', options: facets.creators, selected: params.creator },
    { key: 'tag', title: 'Tag', options: facets.tags, selected: params.tag },
    { key: 'format', title: 'Format', options: facets.extensions, selected: params.format },
    { key: 'license', title: 'Licence', options: facets.licenses, selected: params.license },
  ].filter((group) => group.options.length > 0 || group.selected.length > 0)

  const toggles: { key: string; label: string; hint: string; active: boolean }[] = [
    {
      key: 'presupported',
      label: 'Pre-supported',
      hint: 'Contains files with print supports already applied',
      active: params.presupported,
    },
    {
      key: 'neverPrinted',
      label: 'Never printed',
      hint: 'Nothing logged against this model yet',
      active: params.neverPrinted,
    },
    {
      key: 'missingPreview',
      label: 'No preview',
      hint: 'No thumbnail could be rendered — often a damaged file',
      active: params.missingPreview,
    },
  ]

  const anyActive =
    groups.some((group) => group.selected.length > 0) || toggles.some((toggle) => toggle.active)

  return (
    <aside className="space-y-6 lg:sticky lg:top-6 lg:self-start">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)]">
          Filters
        </h2>
        {anyActive && (
          <Link
            href={buildHref({ q: raw.q, sort: raw.sort }, {})}
            className="flex items-center gap-1 text-xs text-[var(--color-accent)] hover:underline"
          >
            <X className="size-3" />
            Clear
          </Link>
        )}
      </div>

      <div className="space-y-1">
        {toggles.map((toggle) => (
          <Link
            key={toggle.key}
            href={buildHref(raw, { [toggle.key]: toggle.active ? null : '1' })}
            title={toggle.hint}
            className={cn(
              'flex items-center gap-2 rounded-[var(--radius-control)] px-2 py-1.5 text-sm transition-colors',
              toggle.active
                ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]'
                : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-2)]',
            )}
          >
            <span
              className={cn(
                'flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border',
                toggle.active
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white'
                  : 'border-[var(--color-border-strong)]',
              )}
            >
              {toggle.active && <Check className="size-2.5" strokeWidth={3} />}
            </span>
            {toggle.label}
          </Link>
        ))}
      </div>

      {groups.map((group) => (
        <div key={group.key}>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)]">
            {group.title}
          </h3>
          <ul className="space-y-0.5">
            {group.options.slice(0, 12).map((option) => {
              const active = group.selected.includes(option.value)
              return (
                <li key={option.value}>
                  <Link
                    href={toggleHref(raw, group.key, option.value)}
                    className={cn(
                      'flex items-center gap-2 rounded-[var(--radius-control)] px-2 py-1 text-sm transition-colors',
                      active
                        ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]'
                        : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-2)]',
                    )}
                  >
                    <span
                      className={cn(
                        'flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border',
                        active
                          ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white'
                          : 'border-[var(--color-border-strong)]',
                      )}
                    >
                      {active && <Check className="size-2.5" strokeWidth={3} />}
                    </span>
                    <span className="min-w-0 flex-1 truncate" title={option.label}>
                      {option.label}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-[var(--color-ink-faint)]">
                      {NUMBER.format(option.count)}
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </aside>
  )
}
