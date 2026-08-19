'use client'

import { useRouter } from 'next/navigation'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ChevronsUpDown, LogOut } from 'lucide-react'
import type { PolicyUser } from '@pm/core/policy'
import { signOut } from '@/lib/auth-client'
import { ThemeToggle } from './theme-toggle'

const ROLE_LABEL: Record<string, string> = {
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
}

export function UserMenu({ user }: { user: PolicyUser & { name: string; email: string } }) {
  const router = useRouter()
  const initials =
    user.name
      .split(/\s+/)
      .map((part) => part[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?'

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="flex w-full items-center gap-2.5 rounded-[var(--radius-control)] p-1.5 text-left transition-colors hover:bg-[var(--color-surface-2)]">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-soft)] text-xs font-semibold text-[var(--color-accent)]">
          {initials}
        </span>
        <span className="min-w-0 flex-1 lg:block">
          <span className="block truncate text-sm font-medium">{user.name}</span>
          <span className="block truncate text-xs text-[var(--color-ink-faint)]">
            {ROLE_LABEL[String(user.role)] ?? 'Viewer'}
          </span>
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-[var(--color-ink-faint)]" />
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          className="z-50 w-60 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5 shadow-[var(--shadow-pop)]"
        >
          <div className="px-2 py-1.5">
            <p className="truncate text-sm font-medium">{user.name}</p>
            <p className="truncate text-xs text-[var(--color-ink-faint)]">{user.email}</p>
          </div>
          <DropdownMenu.Separator className="my-1.5 h-px bg-[var(--color-border)]" />
          <div className="flex items-center justify-between px-2 py-1">
            <span className="text-sm text-[var(--color-ink-muted)]">Theme</span>
            <ThemeToggle />
          </div>
          <DropdownMenu.Separator className="my-1.5 h-px bg-[var(--color-border)]" />
          <DropdownMenu.Item
            onSelect={async () => {
              await signOut()
              router.push('/login')
              router.refresh()
            }}
            className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-[var(--color-ink-muted)] outline-none data-[highlighted]:bg-[var(--color-surface-2)] data-[highlighted]:text-[var(--color-ink)]"
          >
            <LogOut className="size-4" />
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
