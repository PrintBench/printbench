'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Boxes,
  ClipboardList,
  FolderTree,
  HardDrive,
  Heart,
  History,
  Home,
  Printer,
  Search,
  Settings,
  Stethoscope,
  Tags,
  Upload,
  Users,
} from 'lucide-react'
import type { Route } from 'next'
import type { Action } from '@pb/core/policy'
import { cn } from '@/lib/cn'

interface NavItemBase {
  label: string
  icon: keyof typeof ICONS
  /** Hidden unless the signed-in user has this permission. */
  requires?: Action
}

/**
 * Discriminated so an unbuilt route cannot be linked to by accident: `soon`
 * entries take a plain string and only ever render as inert text, while real
 * entries take a typed Route that must exist.
 */
export type NavItem =
  (NavItemBase & { soon: true; href: string }) | (NavItemBase & { soon?: false; href: Route })

const ICONS = {
  home: Home,
  queue: ClipboardList,
  search: Search,
  boxes: Boxes,
  users: Users,
  folder: FolderTree,
  tags: Tags,
  heart: Heart,
  history: History,
  drive: HardDrive,
  health: Stethoscope,
  printer: Printer,
  settings: Settings,
  upload: Upload,
}

export const NAV_SECTIONS: { title?: string; items: NavItem[] }[] = [
  {
    items: [
      { href: '/', label: 'Dashboard', icon: 'home' },
      { href: '/search', label: 'Search', icon: 'search' },
      { href: '/models', label: 'Models', icon: 'boxes' },
      { href: '/queue', label: 'Print queue', icon: 'queue', requires: 'request:create' },
      { href: '/upload', label: 'Upload', icon: 'upload', requires: 'file:upload' },
    ],
  },
  {
    title: 'Browse',
    items: [
      { href: '/creators', label: 'Creators', icon: 'users' },
      { href: '/collections', label: 'Collections', icon: 'folder' },
      { href: '/tags', label: 'Tags', icon: 'tags' },
      { href: '/lists', label: 'Liked', icon: 'heart' },
      { href: '/prints', label: 'Print history', icon: 'history' },
    ],
  },
  {
    title: 'Manage',
    items: [
      { href: '/admin/libraries', label: 'Libraries', icon: 'drive', requires: 'library:manage' },
      { href: '/admin/printers', label: 'Printers', icon: 'printer', requires: 'printhost:manage' },
      {
        href: '/admin/health',
        label: 'Library health',
        icon: 'health',
        requires: 'library:manage',
      },
      { href: '/admin/users', label: 'Users', icon: 'users', requires: 'user:manage' },
      { href: '/admin/settings', label: 'Settings', icon: 'settings', requires: 'settings:manage' },
    ],
  },
]

export function NavLink({ item }: { item: NavItem }) {
  const pathname = usePathname()
  const Icon = ICONS[item.icon]
  const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)

  if (item.soon === true) {
    return (
      <span
        aria-disabled
        title="Coming in a later phase"
        className="flex cursor-not-allowed items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 py-1.5 text-sm text-[var(--color-ink-faint)] opacity-60"
      >
        <Icon className="size-4 shrink-0" />
        <span className="truncate">{item.label}</span>
        <span className="ml-auto text-[10px] uppercase tracking-wide">soon</span>
      </span>
    )
  }

  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 py-1.5 text-sm transition-colors',
        active
          ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]'
          : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]',
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="truncate">{item.label}</span>
    </Link>
  )
}
