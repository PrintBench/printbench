import Link from 'next/link'
import { validatePasswordReset } from '@pb/auth'
import { getDb } from '@pb/db'
import { ResetPasswordForm } from './reset-form'

export const dynamic = 'force-dynamic'
export const metadata = {
  title: 'Reset password',
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
}

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams
  let valid = false
  if (typeof token === 'string') {
    try {
      await validatePasswordReset(getDb(), token)
      valid = true
    } catch {
      /* Invalid and expired tokens reveal no account details. */
    }
  }
  return (
    <>
      <h1 className="mb-4 text-2xl font-semibold tracking-tight">Reset your password</h1>
      {valid && token ? (
        <ResetPasswordForm token={token} />
      ) : (
        <div className="space-y-4 text-sm">
          <p>This reset link is invalid or has expired. Ask an admin for a new link.</p>
          <Link href="/login" className="text-[var(--color-accent)] hover:underline">
            Back to sign in
          </Link>
        </div>
      )}
    </>
  )
}
