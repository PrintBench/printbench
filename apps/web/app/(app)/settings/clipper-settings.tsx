'use client'

import { useState, useTransition, type FormEvent } from 'react'
import { generateBrowserClipperToken, revokeBrowserClipperToken } from './clipper-actions'

interface TokenEntry {
  id: string
  label: string
  createdAt: Date
  expiresAt: Date
}

const buttonClass =
  'rounded-md border border-[var(--color-border)] px-3 py-2 text-sm font-medium disabled:opacity-50'

export function ClipperSettings({
  initialTokens,
  canImport,
}: {
  initialTokens: TokenEntry[]
  canImport: boolean
}) {
  const [tokens, setTokens] = useState(initialTokens)
  const [label, setLabel] = useState('')
  const [created, setCreated] = useState<{ id: string; token: string }>()
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [pending, startTransition] = useTransition()

  function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setMessage('')
    startTransition(async () => {
      const result = await generateBrowserClipperToken(label)
      if ('error' in result) {
        setError(result.error ?? '')
        return
      }
      setTokens((current) => [result.entry, ...current])
      setCreated({ id: result.entry.id, token: result.token })
      setLabel('')
    })
  }

  function revoke(id: string) {
    setError('')
    setMessage('')
    startTransition(async () => {
      const result = await revokeBrowserClipperToken(id)
      if ('error' in result) {
        setError(result.error ?? '')
        return
      }
      setTokens((current) => current.filter((entry) => entry.id !== id))
      setCreated((current) => (current?.id === id ? undefined : current))
      setMessage('Connection token revoked.')
    })
  }

  return (
    <section
      id="browser-clipper"
      aria-labelledby="browser-clipper-heading"
      className="space-y-4 rounded-lg border border-[var(--color-border)] p-4"
    >
      <h2 id="browser-clipper-heading" className="text-lg font-semibold">
        Browser clipper
      </h2>
      <p className="text-sm">
        Connect the PrintBench browser extension using this installation’s address and a connection
        token. Create a separate token for each browser profile. Tokens expire after 90 days.
      </p>
      {canImport && (
        <form onSubmit={generate} className="flex flex-wrap items-end gap-2">
          <label className="grid min-w-40 flex-1 gap-1 text-sm">
            Browser name
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Work Firefox"
              autoComplete="off"
              maxLength={80}
              required
              className="rounded-md border border-[var(--color-border)] bg-transparent px-3 py-2"
            />
          </label>
          <button className={buttonClass} disabled={pending || !label.trim()}>
            Generate connection token
          </button>
        </form>
      )}
      {created && (
        <div className="grid gap-2">
          <label className="grid gap-1 text-sm">
            Connection token
            <input
              value={created.token}
              readOnly
              autoComplete="off"
              spellCheck={false}
              onFocus={(event) => event.target.select()}
              className="w-full rounded-md border border-[var(--color-border)] bg-transparent p-2 font-mono"
            />
          </label>
          <p className="text-sm">Copy this token now. PrintBench only shows it once.</p>
          <button
            type="button"
            className={buttonClass + ' justify-self-start'}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(created.token)
                setMessage('Connection token copied.')
              } catch {
                setMessage('Select the token and copy it using your browser.')
              }
            }}
          >
            Copy token
          </button>
        </div>
      )}
      {tokens.length > 0 && (
        <ul className="divide-y divide-[var(--color-border)]">
          {tokens.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div>
                <p className="text-sm font-medium">{entry.label}</p>
                <p className="text-sm">
                  Expires{' '}
                  <time dateTime={entry.expiresAt.toISOString()}>
                    {entry.expiresAt.toISOString().slice(0, 10)}
                  </time>
                </p>
              </div>
              <button
                type="button"
                className={buttonClass}
                disabled={pending}
                aria-label={'Revoke token for ' + entry.label}
                onClick={() => revoke(entry.id)}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}
    </section>
  )
}
