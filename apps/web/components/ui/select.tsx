import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/cn'

/**
 * A native select, styled to match Input.
 *
 * Native rather than a listbox rebuilt in React: the options here are short,
 * closed sets, and the platform control already handles keyboard navigation,
 * typeahead and mobile pickers better than a reimplementation would.
 */
export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, children, ...props }, ref) {
  return (
    <div className="relative">
      <select
        ref={ref}
        className={cn(
          'h-10 w-full appearance-none rounded-[var(--radius-control)] border border-[var(--color-border)]',
          'bg-[var(--color-surface)] px-3 pr-9 text-sm text-[var(--color-ink)]',
          'transition-colors focus:border-[var(--color-accent)] disabled:opacity-50',
          'aria-[invalid=true]:border-[var(--color-danger)]',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-[var(--color-ink-faint)]"
      />
    </div>
  )
})
