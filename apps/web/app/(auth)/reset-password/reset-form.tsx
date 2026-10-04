'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field } from '@/components/ui/field'
import { completePasswordReset } from './actions'

export function ResetPasswordForm({ token }: { token: string }) {
  const [message, setMessage] = useState('')
  const [complete, setComplete] = useState(false)
  const [pending, startTransition] = useTransition()
  if (complete)
    return (
      <div className="space-y-4">
        <p role="status">Your password has been reset. Sign in with your new password.</p>
        <Link href="/login" className="text-[var(--color-accent)] hover:underline">
          Back to sign in
        </Link>
      </div>
    )
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        const form = event.currentTarget
        const data = new FormData(form)
        const password = String(data.get('password') ?? '')
        if (password !== String(data.get('confirmation') ?? '')) {
          setMessage('The passwords do not match.')
          return
        }
        setMessage('')
        startTransition(async () => {
          try {
            const result = await completePasswordReset({ token, password })
            if (!result.ok) {
              setMessage(result.error)
              return
            }
            form.reset()
            window.history.replaceState(null, '', '/reset-password')
            setComplete(true)
          } catch {
            setMessage('Could not reset your password. Please try again.')
          }
        })
      }}
    >
      <Field label="New password" htmlFor="password" hint="Between 10 and 200 characters.">
        <Input
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          maxLength={200}
          disabled={pending}
        />
      </Field>
      <Field label="Confirm new password" htmlFor="confirmation">
        <Input
          name="confirmation"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          maxLength={200}
          disabled={pending}
        />
      </Field>
      {message && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {message}
        </p>
      )}
      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending ? 'Resetting…' : 'Reset password'}
      </Button>
    </form>
  )
}
