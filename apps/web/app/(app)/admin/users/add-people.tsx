'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Copy, Link2, Loader2, UserPlus, X } from 'lucide-react'
import { ROLE_ORDER } from '@pb/core/policy'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { Card, CardContent } from '@/components/ui/card'
import { addUser, cancelInvite, invite } from './actions'

/**
 * The two ways to get somebody in.
 *
 * An invitation link is the default, because it lets the person choose their
 * own password — an admin who types someone's password knows it, which is a
 * worse starting point than a link they redeem themselves.
 *
 * Nothing is emailed. A self-hosted instance rarely has SMTP configured, so
 * the link is shown for the admin to copy and send however they already talk
 * to that person. Saying so plainly avoids the obvious question of why no
 * email arrived.
 */

const LABELS: Record<string, string> = { admin: 'Admin', member: 'Member', viewer: 'Viewer' }
const ROLES = [...ROLE_ORDER].reverse()

export interface PendingInvite {
  id: string
  token: string
  email: string | null
  role: string
  expiresAt: string
  invitedByName: string | null
}

type Panel = 'none' | 'invite' | 'add'

export function AddPeople({
  pending,
  origin,
}: {
  pending: PendingInvite[]
  /** Rendered server-side, so the copied link matches how people reach this instance. */
  origin: string
}) {
  const router = useRouter()
  const [panel, setPanel] = useState<Panel>('none')

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setPanel(panel === 'invite' ? 'none' : 'invite')}>
          <Link2 />
          Invite someone
        </Button>
        <Button variant="secondary" onClick={() => setPanel(panel === 'add' ? 'none' : 'add')}>
          <UserPlus />
          Create an account
        </Button>
      </div>

      {panel === 'invite' && <InviteForm origin={origin} onDone={() => router.refresh()} />}
      {panel === 'add' && (
        <AddUserForm
          onDone={() => {
            setPanel('none')
            router.refresh()
          }}
        />
      )}

      {pending.length > 0 && <PendingList invites={pending} origin={origin} />}
    </div>
  )
}

function InviteForm({ origin, onDone }: { origin: string; onDone: () => void }) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('viewer')
  const [error, setError] = useState<string | null>(null)
  const [link, setLink] = useState<string | null>(null)
  const [saving, startSaving] = useTransition()

  function create() {
    setError(null)
    startSaving(async () => {
      const result = await invite({ email: email.trim() || undefined, role })
      if (!result.ok) {
        setError(result.error)
        return
      }
      setLink(`${origin}/invite/${result.token}`)
      setEmail('')
      onDone()
    })
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <p className="text-sm text-[var(--color-ink-muted)]">
          Creates a link that lets one person set up their own account. Nothing is emailed — copy
          the link and send it however you like. It expires in 14 days and works once.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Email"
            htmlFor="invite-email"
            hint="Optional. Locks the invitation to one address and pre-fills it for them."
          >
            <Input
              name="invite-email"
              type="email"
              value={email}
              placeholder="them@example.com"
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>

          <Field label="Role" htmlFor="invite-role">
            <Select name="invite-role" value={role} onChange={(e) => setRole(e.target.value)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {LABELS[r]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {error && (
          <p role="alert" className="text-sm text-[var(--color-danger)]">
            {error}
          </p>
        )}

        {link ? <CopyRow label="Invitation link" value={link} /> : null}

        <Button disabled={saving} onClick={create}>
          {saving ? <Loader2 className="animate-spin" /> : <Link2 />}
          {link ? 'Create another link' : 'Create link'}
        </Button>
      </CardContent>
    </Card>
  )
}

function AddUserForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState('viewer')
  const [error, setError] = useState<string | null>(null)
  const [saving, startSaving] = useTransition()

  const ready = name.trim() && email.trim() && password.length >= 10

  function create() {
    setError(null)
    startSaving(async () => {
      const result = await addUser({ name, email, password, role })
      if (!result.ok) {
        setError(result.error)
        return
      }
      onDone()
    })
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <p className="text-sm text-[var(--color-ink-muted)]">
          Sets up an account with a password you choose and pass on. An invitation link is usually
          better — it lets them pick a password you never see.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="add-name">
            <Input name="add-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Email" htmlFor="add-email">
            <Input
              name="add-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Password" htmlFor="add-password" hint="At least 10 characters.">
            <Input
              name="add-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Field label="Role" htmlFor="add-role">
            <Select name="add-role" value={role} onChange={(e) => setRole(e.target.value)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {LABELS[r]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {error && (
          <p role="alert" className="text-sm text-[var(--color-danger)]">
            {error}
          </p>
        )}

        <Button disabled={saving || !ready} onClick={create}>
          {saving ? <Loader2 className="animate-spin" /> : <UserPlus />}
          Create account
        </Button>
      </CardContent>
    </Card>
  )
}

function PendingList({ invites, origin }: { invites: PendingInvite[]; origin: string }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  return (
    <Card>
      <CardContent className="p-4">
        <h2 className="text-sm font-semibold">Unused invitations</h2>
        <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">
          Anyone holding one of these links can create an account with the role shown. Cancel one
          you did not mean to send.
        </p>

        {error && <p className="mt-2 text-xs text-[var(--color-danger)]">{error}</p>}

        <ul className="mt-3 divide-y divide-[var(--color-border)]">
          {invites.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">
                  {entry.email ?? 'Anyone with the link'}
                  <span className="ml-2 text-xs text-[var(--color-ink-faint)]">
                    {LABELS[entry.role] ?? entry.role}
                  </span>
                </p>
                <p className="text-xs text-[var(--color-ink-faint)]">
                  {entry.invitedByName ? `Invited by ${entry.invitedByName} · ` : ''}
                  expires{' '}
                  {new Date(entry.expiresAt).toLocaleDateString('en-GB', {
                    day: 'numeric',
                    month: 'short',
                  })}
                </p>
              </div>

              <CopyButton value={`${origin}/invite/${entry.token}`} />

              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => {
                  setError(null)
                  startTransition(async () => {
                    const result = await cancelInvite(entry.id)
                    if (!result.ok) setError(result.error)
                    else router.refresh()
                  })
                }}
              >
                <X />
                Cancel
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
      <p className="text-xs font-medium">{label}</p>
      <div className="mt-1.5 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs">{value}</code>
        <CopyButton value={value} />
      </div>
    </div>
  )
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        })
      }}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? 'Copied' : 'Copy link'}
    </Button>
  )
}
