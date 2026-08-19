import * as React from 'react'
import { cn } from '@/lib/cn'

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          'h-10 w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-ink)]',
          'placeholder:text-[var(--color-ink-faint)]',
          'transition-colors focus:border-[var(--color-accent)] disabled:opacity-50',
          'aria-[invalid=true]:border-[var(--color-danger)]',
          className,
        )}
        {...props}
      />
    )
  },
)
