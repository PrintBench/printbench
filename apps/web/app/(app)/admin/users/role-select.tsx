'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ROLE_ORDER } from '@pm/core/policy'
import { cn } from '@/lib/cn'
import { setUserRole } from './actions'

const LABELS: Record<string, string> = { admin: 'Admin', member: 'Member', viewer: 'Viewer' }

export function RoleSelect({
  userId,
  role,
  disabled,
}: {
  userId: string
  role: string
  disabled?: boolean
}) {
  const router = useRouter()
  const [value, setValue] = useState(role)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function onChange(next: string) {
    const previous = value
    setValue(next)
    setError(null)
    startTransition(async () => {
      const result = await setUserRole(userId, next)
      if (!result.ok) {
        setValue(previous) // roll back the optimistic change
        setError(result.error)
        return
      }
      router.refresh()
    })
  }

  return (
    <div className="flex items-center gap-2">
      <select
        value={value}
        disabled={disabled || pending}
        onChange={(event) => onChange(event.target.value)}
        aria-label="Role"
        className={cn(
          'h-8 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
        title={disabled ? 'You cannot change your own role' : undefined}
      >
        {[...ROLE_ORDER].reverse().map((r) => (
          <option key={r} value={r}>
            {LABELS[r]}
          </option>
        ))}
      </select>
      {error && <span className="text-xs text-[var(--color-danger)]">{error}</span>}
    </div>
  )
}
