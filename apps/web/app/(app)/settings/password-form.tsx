'use client'

import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field } from '@/components/ui/field'
import { changeOwnPassword } from './password-actions'

export function PasswordForm({ email }: { email: string }) {
  const [message, setMessage] = useState('')
  const [pending, startTransition] = useTransition()

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const currentPassword = String(data.get('currentPassword') ?? '')
    const newPassword = String(data.get('newPassword') ?? '')
    if (newPassword !== String(data.get('confirmPassword') ?? '')) {
      setMessage('The new passwords do not match.')
      return
    }
    setMessage('')
    startTransition(async () => {
      try {
        const result = await changeOwnPassword({ currentPassword, newPassword })
        if (!result.ok) {
          setMessage(result.error)
          return
        }
        form.reset()
        setMessage('Password changed. Your other sessions have been signed out.')
      } catch {
        setMessage('Could not change your password. Please try again.')
      }
    })
  }

  return (
    <section
      id="password"
      aria-labelledby="password-heading"
      className="space-y-4 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6"
    >
      <div>
        <h2 id="password-heading" className="text-lg font-semibold">
          Password
        </h2>
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
          Signed in as {email}. Changing your password signs out your other sessions.
        </p>
      </div>
      <form onSubmit={submit} className="space-y-3">
        <input type="hidden" name="username" value={email} autoComplete="username" />
        <Field label="Current password" htmlFor="currentPassword">
          <Input
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
            maxLength={200}
            disabled={pending}
          />
        </Field>
        <Field label="New password" htmlFor="newPassword" hint="Between 10 and 200 characters.">
          <Input
            name="newPassword"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            maxLength={200}
            disabled={pending}
          />
        </Field>
        <Field label="Confirm new password" htmlFor="confirmPassword">
          <Input
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            maxLength={200}
            disabled={pending}
          />
        </Field>
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? 'Changing…' : 'Change password'}
        </Button>
        <p role="status" aria-live="polite" className="text-sm">
          {message}
        </p>
      </form>
    </section>
  )
}
