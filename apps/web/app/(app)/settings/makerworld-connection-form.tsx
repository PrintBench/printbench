'use client'

import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { setMakerWorldCookie } from './makerworld-actions'

export function MakerWorldConnectionForm({ initialSaved }: { initialSaved: boolean }) {
  const [cookie, setCookie] = useState('')
  const [saved, setSaved] = useState(initialSaved)
  const [message, setMessage] = useState('')
  const [pending, startTransition] = useTransition()

  function updateCookie(value: string) {
    setMessage('')
    startTransition(async () => {
      try {
        const result = await setMakerWorldCookie(value)
        if (!result.ok) {
          setMessage(result.error)
          return
        }
        setSaved(result.saved)
        setCookie('')
        setMessage(result.saved ? 'Cookie saved for your account.' : 'Cookie removed.')
      } catch {
        setMessage('Could not update your MakerWorld connection.')
      }
    })
  }

  return (
    <section
      id="makerworld"
      aria-labelledby="makerworld-heading"
      className="space-y-4 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6"
    >
      <div>
        <h2 id="makerworld-heading" className="text-lg font-semibold">
          MakerWorld
        </h2>
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
          Save your MakerWorld token cookie to download print profiles when importing model links.
          It is saved for your PrintBench account and never shown again.
        </p>
      </div>
      <p className="text-sm">Cookie: {saved ? 'Saved' : 'Not saved'}</p>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          updateCookie(cookie)
        }}
      >
        <label className="block space-y-1 text-sm">
          <span>Account cookie</span>
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={cookie}
            onChange={(event) => setCookie(event.target.value)}
            disabled={pending}
          />
        </label>
        <div className="flex gap-2">
          <Button type="submit" variant="secondary" disabled={pending || !cookie.trim()}>
            {pending ? 'Updating…' : 'Save cookie'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={pending || !saved}
            onClick={() => updateCookie('')}
          >
            Remove cookie
          </Button>
        </div>
        <p role="status" aria-live="polite" className="text-sm">
          {message}
        </p>
      </form>
    </section>
  )
}
