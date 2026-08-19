import { redirect } from 'next/navigation'
import { ShieldCheck } from 'lucide-react'
import { needsFirstRunSetup } from '@/lib/setup'
import { SetupForm } from './setup-form'

export const dynamic = 'force-dynamic'

export default async function SetupPage() {
  // Closes permanently once any account exists — otherwise anyone reaching this
  // URL on a public instance could grant themselves admin.
  if (!(await needsFirstRunSetup())) redirect('/login')

  return (
    <>
      <div className="mb-6">
        <span className="mb-4 inline-flex items-center gap-1.5 rounded-full bg-[var(--color-accent-soft)] px-2.5 py-1 text-xs font-medium text-[var(--color-accent)]">
          <ShieldCheck className="size-3.5" />
          First run
        </span>
        <h1 className="text-2xl font-semibold tracking-tight">Create your admin account</h1>
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
          This is the only time this page is available. Once an account exists it
          closes for good, and further users are added from Settings.
        </p>
      </div>
      <SetupForm />
    </>
  )
}
