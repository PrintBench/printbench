import Link from 'next/link'

export const metadata = { title: 'Forgot password' }

export default function ForgotPasswordPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Forgot your password?</h1>
      <p className="text-sm text-[var(--color-ink-muted)]">
        Ask a PrintBench admin for a password reset link. They can create one in Users. You choose
        your new password yourself; the admin never needs to know it.
      </p>
      <p className="text-sm text-[var(--color-ink-muted)]">
        If you are the only admin and cannot sign in, the server owner can create a reset link using
        PrintBench’s recovery command. No email delivery is required.
      </p>
      <Link href="/login" className="text-sm text-[var(--color-accent)] hover:underline">
        Back to sign in
      </Link>
    </div>
  )
}
