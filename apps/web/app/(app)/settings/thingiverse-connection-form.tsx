'use client'

import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { setThingiverseToken } from './thingiverse-actions'

export function ThingiverseConnectionForm({ initialSaved }: { initialSaved: boolean }) {
  const [token, setToken] = useState('')
  const [saved, setSaved] = useState(initialSaved)
  const [message, setMessage] = useState('')
  const [pending, startTransition] = useTransition()

  function updateToken(value: string) {
    setMessage('')
    startTransition(async () => {
      try {
        const result = await setThingiverseToken(value)
        if (!result.ok) {
          setMessage(result.error)
          return
        }
        setSaved(result.saved)
        setToken('')
        setMessage(result.saved ? 'API token saved for your account.' : 'API token removed.')
      } catch {
        setMessage('Could not update your Thingiverse connection.')
      }
    })
  }

  return (
    <section
      id="thingiverse"
      aria-labelledby="thingiverse-heading"
      className="space-y-4 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6"
    >
      <div>
        <h2 id="thingiverse-heading" className="text-lg font-semibold">
          Thingiverse
        </h2>
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
          Save your own Thingiverse API token to import model links. It is saved for your PrintBench
          account and never shown again. See{' '}
          <a
            href="https://www.thingiverse.com/developers"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            Thingiverse’s developer documentation
          </a>{' '}
          to create an app and obtain a token.
        </p>
      </div>
      <p className="text-sm">API token: {saved ? 'Saved' : 'Not saved'}</p>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          updateToken(token)
        }}
      >
        <label className="block space-y-1 text-sm">
          <span>API token</span>
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(event) => setToken(event.target.value)}
            disabled={pending}
          />
        </label>
        <div className="flex gap-2">
          <Button type="submit" variant="secondary" disabled={pending || !token.trim()}>
            {pending ? 'Updating…' : 'Save API token'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={pending || !saved}
            onClick={() => updateToken('')}
          >
            Remove API token
          </Button>
        </div>
        <p role="status" aria-live="polite" className="text-sm">
          {message}
        </p>
      </form>
    </section>
  )
}
