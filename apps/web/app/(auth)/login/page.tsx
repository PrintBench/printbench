import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getSessionUser } from '@pb/auth'
import { needsFirstRunSetup } from '@/lib/setup'
import { LoginForm } from './login-form'

export const dynamic = 'force-dynamic'

export default async function LoginPage() {
  // A brand-new instance has no account to sign in to; send them to setup.
  if (await needsFirstRunSetup()) redirect('/setup')
  if (await getSessionUser()) redirect('/')

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
          Sign in to browse your print library.
        </p>
      </div>
      <LoginForm />
      <p className="mt-6 text-xs text-[var(--color-ink-faint)]">
        No account?{' '}
        <Link href="/" className="text-[var(--color-accent)] hover:underline">
          Ask an admin to invite you
        </Link>
        .
      </p>
    </>
  )
}
