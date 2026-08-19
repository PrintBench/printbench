'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Route } from 'next'
import { Command } from 'cmdk'
import { Search } from 'lucide-react'
import { NAV_SECTIONS } from './nav'

/**
 * Command palette. Shipped early on purpose: perceived speed of finding things
 * matters more than perfect ranking, and this is the fastest path to any screen.
 *
 * Phase 5 adds live model/creator/tag results from the search index; for now it
 * navigates.
 */
export function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const router = useRouter()

  const go = useCallback(
    (href: Route) => {
      onOpenChange(false)
      router.push(href)
    },
    [router, onOpenChange],
  )

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command menu"
      className="fixed inset-0 z-50"
    >
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-[2px]"
        onClick={() => onOpenChange(false)}
        aria-hidden
      />
      <div className="fixed left-1/2 top-[15vh] w-[92vw] max-w-lg -translate-x-1/2 overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-pop)]">
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3">
          <Search className="size-4 text-[var(--color-ink-faint)]" />
          <Command.Input
            autoFocus
            placeholder="Jump to…"
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-[var(--color-ink-faint)]"
          />
        </div>
        <Command.List className="max-h-80 overflow-y-auto p-1.5">
          <Command.Empty className="px-3 py-8 text-center text-sm text-[var(--color-ink-muted)]">
            Nothing matches that.
          </Command.Empty>
          {NAV_SECTIONS.map((section, i) => (
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
