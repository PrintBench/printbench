'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { LogIn } from 'lucide-react'
import { signIn } from '@/lib/auth-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field } from '@/components/ui/field'

export function LoginForm() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    const data = new FormData(event.currentTarget)

    const { error: authError } = await signIn.email({
      email: String(data.get('email') ?? ''),
      password: String(data.get('password') ?? ''),
    })

    if (authError) {
      // Deliberately vague: never reveal whether an email exists.
      setError('That email and password combination did not work.')
      return
    }
    startTransition(() => {
      router.push('/')
      router.refresh()
    })
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field label="Email" htmlFor="email">
        <Input name="email" type="email" autoComplete="email" required autoFocus />
      </Field>
      <Field label="Password" htmlFor="password">
        <Input name="password" type="password" autoComplete="current-password" required />
      </Field>

      {error && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}

      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        <LogIn />
        {pending ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  )
}
