import * as React from 'react'

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: React.ReactNode
}) {
  return (
    <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-[var(--color-ink-muted)]">{description}</p>}
      </div>
      {/*
        The action row wraps rather than holding one line: on a phone a model
        page can carry seven buttons, and shrink-0 would push them off the
        right edge instead of letting them fall onto a second row.
      */}
      {actions && (
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">{actions}</div>
      )}
    </header>
  )
}
