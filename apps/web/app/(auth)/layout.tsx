import Link from 'next/link'
import { PrintBenchLogo } from '@/components/brand/logo'

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      <div className="flex flex-col justify-center px-6 py-12 sm:px-12">
        <div className="mx-auto w-full max-w-sm">
          <Link href="/" className="mb-8 inline-block">
            {/* The full lockup, tagline and all: this is the front door. */}
            <PrintBenchLogo className="text-xl" tagline />
          </Link>
          {children}
        </div>
      </div>

      {/* Decorative panel; hidden on small screens where it would just add scroll. */}
      <div
        aria-hidden
        className="relative hidden overflow-hidden border-l border-[var(--color-border)] bg-[var(--color-surface-2)] lg:block"
      >
        <div
          className="absolute inset-0 opacity-[0.5]"
          style={{
            backgroundImage:
              'radial-gradient(circle at 1px 1px, var(--color-border-strong) 1px, transparent 0)',
            backgroundSize: '22px 22px',
          }}
        />
        <div className="absolute inset-0 flex items-center justify-center p-16">
          <blockquote className="max-w-md text-balance text-xl font-medium leading-relaxed text-[var(--color-ink-muted)]">
            Every STL, 3MF and print in one place — indexed where it already
            lives, and findable in a keystroke.
          </blockquote>
        </div>
      </div>
    </div>
  )
}
