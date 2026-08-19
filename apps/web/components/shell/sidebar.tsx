'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Boxes, Menu, X } from 'lucide-react'
import type { Action, PolicyUser } from '@pm/core/policy'
import { can } from '@pm/core/policy'
import { cn } from '@/lib/cn'
import { NAV_SECTIONS, NavLink } from './nav'
import { UserMenu } from './user-menu'
import { CommandTrigger } from './command-menu'

export function Sidebar({ user }: { user: PolicyUser & { name: string; email: string } }) {
  const [open, setOpen] = useState(false)

  // The nav is filtered by the same can() the server enforces with, so a link
  // is never shown for something the action would refuse.
  const sections = NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => !item.requires || can(user, item.requires as Action)),
  })).filter((section) => section.items.length > 0)

  return (
    <>
      {/* Mobile bar */}
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2 lg:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open navigation"
          className="flex size-9 items-center justify-center rounded-[var(--radius-control)] text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-2)]"
        >
          <Menu className="size-5" />
        </button>
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <span className="flex size-7 items-center justify-center rounded-md bg-[var(--color-accent)] text-[var(--color-accent-ink)]">
            <Boxes className="size-4" />
          </span>
          Print Manager
        </Link>
        <div className="ml-auto">
          <UserMenu user={user} />
        </div>
      </div>

      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-64 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] transition-transform lg:static lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-14 items-center gap-2 px-4">
          <Link href="/" className="flex items-center gap-2.5 font-semibold tracking-tight">
            <span className="flex size-8 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-accent)] text-[var(--color-accent-ink)]">
              <Boxes className="size-[18px]" />
            </span>
            Print Manager
          </Link>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close navigation"
            className="ml-auto flex size-8 items-center justify-center rounded-md text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-2)] lg:hidden"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="px-3 pb-2">
          <CommandTrigger />
        </div>

        <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-2">
          {sections.map((section, i) => (
            <div key={section.title ?? i} className="space-y-0.5">
              {section.title && (
                <p className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-ink-faint)]">
                  {section.title}
                </p>
              )}
              {section.items.map((item) => (
                <NavLink key={item.href} item={item} />
              ))}
            </div>
          ))}
        </nav>

        <div className="hidden border-t border-[var(--color-border)] p-3 lg:block">
          <UserMenu user={user} />
        </div>
      </aside>
    </>
  )
}
