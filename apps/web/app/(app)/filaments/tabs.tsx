import Link from 'next/link'
import { cn } from '@/lib/cn'

/** Switches between the user's own spools and the bundled filament catalogue. */
export function FilamentTabs({ active }: { active: 'spools' | 'catalog' }) {
  const tabs = [
    { key: 'spools', href: '/filaments', label: 'My spools' },
    { key: 'catalog', href: '/filaments/catalog', label: 'Catalogue' },
  ] as const
  return (
    <nav
      aria-label="Filament sections"
      className="mb-6 flex gap-1 border-b border-[var(--color-border)]"
    >
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={active === tab.key ? 'page' : undefined}
          className={cn(
            '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
            active === tab.key
              ? 'border-[var(--color-accent)] text-[var(--color-ink)]'
              : 'border-transparent text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  )
}
