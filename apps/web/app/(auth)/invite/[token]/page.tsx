import Link from 'next/link'
import { MailX, UserPlus } from 'lucide-react'
import { inviteByToken } from '@pb/core'
import { getDb } from '@pb/db'
import { Button } from '@/components/ui/button'
import { InviteForm } from './invite-form'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Accept invitation' }

const ROLE_BLURB: Record<string, string> = {
  admin: 'You will be an admin: everything below, plus libraries, users and settings.',
  member: 'You will be a member: browse and download, and add or edit models, tags and prints.',
  viewer: 'You will be a viewer: browse, search and download everything in the library.',
}

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const invitation = await inviteByToken(getDb(), token)

  /*
   * One refusal for every reason — unknown, revoked, spent, expired. Telling
   * someone which would confirm to anyone guessing tokens that they had found
   * a real one.
   */
  if (!invitation) {
    return (
      <div>
        <span className="mb-4 inline-flex items-center gap-1.5 rounded-full bg-[var(--color-surface-2)] px-2.5 py-1 text-xs font-medium text-[var(--color-ink-muted)]">
          <MailX className="size-3.5" />
          Invitation
        </span>
        <h1 className="text-2xl font-semibold tracking-tight">This link cannot be used</h1>
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
          It may have expired, been used already, or been cancelled. Ask whoever invited you for a
          fresh one.
        </p>
        <Button asChild variant="secondary" className="mt-6">
          <Link href="/login">Go to sign in</Link>
        </Button>
      </div>
    )
  }

  return (
    <>
      <div className="mb-6">
        <span className="mb-4 inline-flex items-center gap-1.5 rounded-full bg-[var(--color-accent-soft)] px-2.5 py-1 text-xs font-medium text-[var(--color-accent)]">
          <UserPlus className="size-3.5" />
          Invitation
        </span>
        <h1 className="text-2xl font-semibold tracking-tight">Set up your account</h1>
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
          {ROLE_BLURB[invitation.role] ?? 'Choose a password and you are in.'}
        </p>
      </div>
      <InviteForm token={token} email={invitation.email} />
    </>
  )
}
