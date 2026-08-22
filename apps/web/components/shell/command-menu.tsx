'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Route } from 'next'
import { Command } from 'cmdk'
import { Boxes, FolderTree, Loader2, Search, Tag, User } from 'lucide-react'
import { NAV_SECTIONS } from './nav'

interface QuickHit {
  kind: 'model' | 'creator' | 'tag' | 'collection'
  id: string
  publicId: string | null
  label: string
  detail: string | null
}

const KIND_ICON = {
  model: Boxes,
  creator: User,
  tag: Tag,
  collection: FolderTree,
} as const

const KIND_LABEL = {
  model: 'Models',
  creator: 'Creators',
  tag: 'Tags',
  collection: 'Collections',
} as const

/**
 * Command palette.
 *
 * Shipped early on purpose: for finding things, perceived speed matters more
 * than perfect ranking, and this is the shortest path to anything in the app.
 * It searches live as you type, and falls back to navigation when the query is
 * empty.
 */
export function CommandMenu({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<QuickHit[]>([])
  const [loading, setLoading] = useState(false)
  const requestId = useRef(0)

  const go = useCallback(
    (href: Route) => {
      onOpenChange(false)
      setQuery('')
      router.push(href)
    },
    [router, onOpenChange],
  )

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length === 0) {
      setHits([])
      setLoading(false)
      return
    }

    setLoading(true)
    const id = ++requestId.current
    const controller = new AbortController()

    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, {
          signal: controller.signal,
        })
        const data = (await response.json()) as { hits?: QuickHit[] }
        // Ignore a slow response that has been overtaken by a newer keystroke,
        // or results flicker back and forth as they arrive out of order.
        if (id === requestId.current) setHits(data.hits ?? [])
      } catch {
        if (id === requestId.current) setHits([])
      } finally {
        if (id === requestId.current) setLoading(false)
      }
    }, 140)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query])

  const grouped = groupHits(hits)

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command menu"
      // cmdk filters client-side by default, which would hide server results
      // that matched by stemming, accent folding or a typo.
      shouldFilter={query.trim().length === 0}
      className="fixed inset-0 z-50"
    >
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-[2px]"
        onClick={() => onOpenChange(false)}
        aria-hidden
      />
      <div className="fixed left-1/2 top-[12vh] w-[92vw] max-w-xl -translate-x-1/2 overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-pop)]">
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3">
          <Search className="size-4 shrink-0 text-[var(--color-ink-faint)]" />
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="Search models, creators and tags…"
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-[var(--color-ink-faint)]"
          />
          {loading && (
            <Loader2 className="size-4 shrink-0 animate-spin text-[var(--color-ink-faint)]" />
          )}
        </div>

        <Command.List className="max-h-[60vh] overflow-y-auto p-1.5">
          <Command.Empty className="px-3 py-8 text-center text-sm text-[var(--color-ink-muted)]">
            {loading ? 'Searching…' : `Nothing matches "${query}"`}
          </Command.Empty>

          {query.trim().length > 0 &&
            grouped.map(([kind, items]) => {
              const Icon = KIND_ICON[kind]
              return (
                <Command.Group
                  key={kind}
                  heading={KIND_LABEL[kind]}
                  className="px-1 py-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] [&_[cmdk-group-items]]:mt-1 [&_[cmdk-group-items]]:space-y-0.5"
                >
                  {items.map((hit) => (
                    <Command.Item
                      key={`${hit.kind}:${hit.id}`}
                      value={`${hit.kind}-${hit.id}`}
                      onSelect={() => go(hrefFor(hit))}
                      className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-sm font-normal normal-case tracking-normal text-[var(--color-ink)] data-[selected=true]:bg-[var(--color-accent-soft)] data-[selected=true]:text-[var(--color-accent)]"
                    >
                      <Icon className="size-4 shrink-0 text-[var(--color-ink-faint)]" />
                      <span className="min-w-0 flex-1 truncate">{hit.label}</span>
                      {hit.detail && (
                        <span className="shrink-0 text-xs text-[var(--color-ink-faint)]">
                          {hit.detail}
                        </span>
                      )}
                    </Command.Item>
                  ))}
                </Command.Group>
              )
            })}

          {query.trim().length > 0 && (
            <Command.Item
              value="see-all-results"
              onSelect={() => go(`/search?q=${encodeURIComponent(query.trim())}` as Route)}
              className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-sm text-[var(--color-ink-muted)] data-[selected=true]:bg-[var(--color-accent-soft)] data-[selected=true]:text-[var(--color-accent)]"
            >
              <Search className="size-4 shrink-0" />
              Search everything for &ldquo;{query.trim()}&rdquo;
            </Command.Item>
          )}

          {query.trim().length === 0 &&
            NAV_SECTIONS.map((section, i) => (
              <Command.Group
                key={section.title ?? i}
                heading={section.title ?? 'Go to'}
                className="px-1 py-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] [&_[cmdk-group-items]]:mt-1 [&_[cmdk-group-items]]:space-y-0.5"
              >
                {section.items.map((item) => (
                  <Command.Item
                    key={item.href}
                    value={`${item.label} ${item.href}`}
                    disabled={item.soon === true}
                    onSelect={() => {
                      // Narrowing keeps unbuilt routes unreachable.
                      if (item.soon !== true) go(item.href)
                    }}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm font-normal normal-case tracking-normal text-[var(--color-ink)] data-[disabled=true]:opacity-40 data-[selected=true]:bg-[var(--color-accent-soft)] data-[selected=true]:text-[var(--color-accent)]"
                  >
                    {item.label}
                    {item.soon === true && (
                      <span className="ml-auto text-[10px] uppercase text-[var(--color-ink-faint)]">
                        soon
                      </span>
                    )}
                  </Command.Item>
                ))}
              </Command.Group>
            ))}
        </Command.List>
      </div>
    </Command.Dialog>
  )
}

function hrefFor(hit: QuickHit): Route {
  switch (hit.kind) {
    case 'model':
      return `/models/${hit.publicId}` as Route
    case 'tag':
      return `/search?tag=${hit.id}` as Route
    case 'creator':
      return `/search?creator=${hit.id}` as Route
    case 'collection':
      return `/search?collection=${hit.id}` as Route
  }
}

/** Keeps a stable group order regardless of how the server ranked them. */
function groupHits(hits: QuickHit[]): [QuickHit['kind'], QuickHit[]][] {
  const order: QuickHit['kind'][] = ['model', 'creator', 'tag', 'collection']
  return order
    .map(
      (kind) => [kind, hits.filter((hit) => hit.kind === kind)] as [QuickHit['kind'], QuickHit[]],
    )
    .filter(([, items]) => items.length > 0)
}

/** Sidebar button that opens the palette, and owns the global shortcut. */
export function CommandTrigger() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setOpen((value) => !value)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-sm text-[var(--color-ink-faint)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-ink-muted)]"
      >
        <Search className="size-4" />
        <span>Search…</span>
        <kbd className="ml-auto rounded border border-[var(--color-border)] px-1.5 py-0.5 font-sans text-[10px] text-[var(--color-ink-faint)]">
          ⌘K
        </kbd>
      </button>
      <CommandMenu open={open} onOpenChange={setOpen} />
    </>
  )
}
