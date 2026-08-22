'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertTriangle,
  Loader2,
  MoreHorizontal,
  Pencil,
  ShieldOff,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field } from '@/components/ui/field'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { deleteUser, setSuspended, updateUser } from './actions'

/**
 * Everything you can do to one account, behind one control.
 *
 * Editing, suspending and deleting share a row and a confirmation pattern, so
 * they share a panel rather than crowding the table with three buttons each.
 *
 * None of these appear for your own account. Suspending or deleting yourself
 * is a lockout with no way back through the UI, and the server refuses it
 * anyway — this just avoids offering an action that cannot work.
 */

type Mode = 'menu' | 'edit' | 'confirm-delete'

export function UserActions({
  userId,
  name,
  email,
  suspended,
}: {
  userId: string
  name: string
  email: string
  suspended: boolean
}) {
  const router = useRouter()
  const [mode, setMode] = useState<Mode>('menu')
  const [draftName, setDraftName] = useState(name)
  const [draftEmail, setDraftEmail] = useState(email)
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setError(null)
    startTransition(async () => {
      const result = await action()
      if (!result.ok) {
        setError(result.error)
        return
      }
      setMode('menu')
      router.refresh()
    })
  }

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) return
        setMode('menu')
        setDraftName(name)
        setDraftEmail(email)
        setTyped('')
        setError(null)
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={`Manage ${name}`} title={`Manage ${name}`}>
          <MoreHorizontal />
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-72 space-y-3 p-3">
        {mode === 'menu' && (
          <>
            <div>
              <Button variant="secondary" size="sm" onClick={() => setMode('edit')}>
                <Pencil />
                Edit details
              </Button>
              <p className="mt-1.5 text-xs text-[var(--color-ink-muted)]">
                Change their name or the email they sign in with.
              </p>
            </div>

            <div className="border-t border-[var(--color-border)] pt-3">
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => run(() => setSuspended(userId, !suspended))}
              >
                {pending ? (
                  <Loader2 className="animate-spin" />
                ) : suspended ? (
                  <ShieldCheck />
                ) : (
                  <ShieldOff />
                )}
                {suspended ? 'Restore access' : 'Suspend'}
              </Button>
              <p className="mt-1.5 text-xs text-[var(--color-ink-muted)]">
                {suspended
                  ? 'Lets them sign in again with the same password.'
                  : 'Signs them out everywhere and blocks sign-in. Nothing they added is removed.'}
              </p>
            </div>

            <div className="border-t border-[var(--color-border)] pt-3">
              <Button
                variant="ghost"
                size="sm"
                className="text-[var(--color-danger)]"
                onClick={() => setMode('confirm-delete')}
              >
                <Trash2 />
                Delete account
              </Button>
              <p className="mt-1.5 text-xs text-[var(--color-ink-muted)]">
                Removes the account for good. Suspending is usually what you want.
              </p>
            </div>
          </>
        )}

        {mode === 'edit' && (
          <>
            <Field label="Name" htmlFor={`name-${userId}`}>
              <Input
                name={`name-${userId}`}
                autoFocus
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
              />
            </Field>
            <Field label="Email" htmlFor={`email-${userId}`}>
              <Input
                name={`email-${userId}`}
                type="email"
                value={draftEmail}
                onChange={(e) => setDraftEmail(e.target.value)}
              />
            </Field>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={pending || !draftName.trim() || !draftEmail.trim()}
                onClick={() =>
                  run(() => updateUser(userId, { name: draftName, email: draftEmail }))
                }
              >
                {pending && <Loader2 className="animate-spin" />}
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setMode('menu')}>
                Cancel
              </Button>
            </div>
          </>
        )}

        {mode === 'confirm-delete' && (
          <>
            <p className="flex items-start gap-2 text-sm text-[var(--color-danger)]">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              Delete {name}&apos;s account permanently?
            </p>
            <p className="text-xs text-[var(--color-ink-muted)]">
              Models, tags and print history they added stay in the library. Type{' '}
              <span className="font-medium text-[var(--color-ink)]">{email}</span> to confirm.
            </p>
            <Input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={email}
              aria-label={`Type ${email} to confirm`}
            />
            <div className="flex gap-2">
              <Button
                variant="danger"
                size="sm"
                disabled={pending || typed.trim().toLowerCase() !== email.toLowerCase()}
                onClick={() => run(() => deleteUser(userId))}
              >
                {pending && <Loader2 className="animate-spin" />}
                Delete permanently
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setMode('menu')}>
                Cancel
              </Button>
            </div>
          </>
        )}

        {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}
      </PopoverContent>
    </Popover>
  )
}
