'use client'

import Link from 'next/link'
import type { Route } from 'next'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/cn'

export interface DiagnosticsTab {
  href: Route
  label: string
}

export function DiagnosticsTabs({ tabs }: { tabs: DiagnosticsTab[] }) {
  const pathname = usePathname()
  // The first tab is the section root, so it only matches exactly.
  const root = tabs[0]?.href

  return (
    <nav
      aria-label="Diagnostics"
      className="mb-6 flex gap-1 overflow-x-auto border-b border-[var(--color-border)]"
    >
      {tabs.map((tab) => {
        const active = tab.href === root ? pathname === tab.href : pathname.startsWith(tab.href)
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors',
              active
                ? 'border-[var(--color-accent)] font-medium text-[var(--color-accent)]'
                : 'border-transparent text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
            )}
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
