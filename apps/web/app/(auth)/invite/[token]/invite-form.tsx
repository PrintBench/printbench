'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field } from '@/components/ui/field'
import { acceptInvite } from './actions'

const MIN_PASSWORD = 10

export function InviteForm({
  token,
  email,
}: {
  token: string
  /** Fixed when the invitation named an address; chosen by them otherwise. */
  email: string | null
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [pending, startTransition] = useTransition()

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    const form = new FormData(event.currentTarget)

    const result = await acceptInvite(form)
    if (!result.ok) {
      setError(result.error)
      return
    }
    startTransition(() => {
      router.push('/')
      router.refresh()
    })
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <input type="hidden" name="token" value={token} />

      <Field label="Your name" htmlFor="name">
        <Input name="name" autoComplete="name" required autoFocus />
      </Field>

      <Field
        label="Email"
        htmlFor="email"
        hint={email ? 'Set by whoever invited you.' : undefined}
      >
        <Input
          name="email"
          type="email"
          autoComplete="email"
          required
          defaultValue={email ?? ''}
          // Fixed rather than merely pre-filled: the invitation was addressed
          // to this person. The server ignores the field in that case anyway.
          readOnly={Boolean(email)}
        />
      </Field>

      <Field
        label="Password"
        htmlFor="password"
        hint={`At least ${MIN_PASSWORD} characters. A passphrase of a few words beats a short complex one.`}
        error={tooShort ? `Needs at least ${MIN_PASSWORD} characters.` : undefined}
      >
        <Input
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>

      {error && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}

      <Button type="submit" size="lg" className="w-full" disabled={pending || tooShort}>
        {pending ? 'Creating…' : 'Create my account'}
        <ArrowRight />
      </Button>
    </form>
  )
}
