'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field } from '@/components/ui/field'
import { createFirstAdmin } from './actions'

const MIN_PASSWORD = 10

export function SetupForm() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [pending, startTransition] = useTransition()

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    const form = new FormData(event.currentTarget)

    const result = await createFirstAdmin(form)
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
      <Field label="Your name" htmlFor="name">
        <Input name="name" autoComplete="name" required autoFocus />
      </Field>
      <Field label="Email" htmlFor="email">
        <Input name="email" type="email" autoComplete="email" required />
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
        {pending ? 'Creating…' : 'Create admin account'}
        <ArrowRight />
      </Button>
    </form>
  )
}
