import * as React from 'react'
import { cn } from '@/lib/cn'

/**
 * Empty states are a first-class part of this app, not an afterthought: for the
 * first few phases most screens are empty, and an empty screen should still
 * tell you what it is and what to do next.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-[var(--radius-card)] border border-dashed border-[var(--color-border-strong)] px-6 py-16 text-center',
        className,
      )}
    >
      {icon && (
        <div className="mb-4 flex size-11 items-center justify-center rounded-full bg-[var(--color-surface-2)] text-[var(--color-ink-faint)] [&_svg]:size-5">
          {icon}
        </div>
      )}
      <h3 className="text-sm font-semibold text-[var(--color-ink)]">{title}</h3>
      {description && (
        <p className="mt-1 max-w-sm text-sm text-[var(--color-ink-muted)]">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}
