'use client'

import { useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { UploadTarget } from './actions'
import {
  pollMakerWorldImport,
  readMakerWorldCookieStatus,
  setMakerWorldCookie,
  startMakerWorldImport,
  type MakerWorldImportStatus,
} from './makerworld-actions'

export function MakerWorldImportForm({ targets }: { targets: UploadTarget[] }) {
  const router = useRouter()
  const [libraryId, setLibraryId] = useState(targets[0]?.id ?? '')
  const [url, setUrl] = useState('')
  const [cookie, setCookie] = useState('')
  const [saved, setSaved] = useState<boolean | null>(null)
  const [cookieMessage, setCookieMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [importId, setImportId] = useState<string | null>(null)
  const [status, setStatus] = useState<MakerWorldImportStatus | null>(null)
  const [pending, startTransition] = useTransition()
  const [cookiePending, startCookieTransition] = useTransition()
  const [pollAttempt, setPollAttempt] = useState(0)
  const [pollError, setPollError] = useState<string | null>(null)
  const active = status?.state === 'queued' || status?.state === 'importing'

  useEffect(() => {
    let cancelled = false
    void readMakerWorldCookieStatus()
      .then((result) => {
        if (cancelled) return
        if (result.ok) setSaved(result.saved)
        else setCookieMessage(result.error)
      })
      .catch(() => {
        if (!cancelled) setCookieMessage('Could not check your MakerWorld connection.')
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!importId || !active) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const result = await pollMakerWorldImport(importId!)
        if (cancelled) return
        if (!result.ok) {
          setPollError(result.error)
          return
        }
        setPollError(null)
        setStatus(result.status)
        if (result.status.state === 'complete') router.refresh()
        else if (result.status.state !== 'failed') timer = setTimeout(() => void poll(), 3000)
      } catch {
        if (!cancelled) setPollError('Connection interrupted. The import may still be running.')
      }
    }
    timer = setTimeout(() => void poll(), 1000)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [importId, active, pollAttempt, router])

  function updateCookie(value: string) {
    setCookieMessage('')
    startCookieTransition(async () => {
      try {
        const result = await setMakerWorldCookie(value)
        if (!result.ok) {
          setCookieMessage(result.error)
          return
        }
        setSaved(result.saved)
        setCookie('')
        setCookieMessage(result.saved ? 'Cookie saved for your account.' : 'Cookie removed.')
      } catch {
        setCookieMessage('Could not update your MakerWorld connection.')
      }
    })
  }

  return (
    <section
      aria-labelledby="makerworld-heading"
      className="space-y-4 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6"
    >
      <div>
        <h2 id="makerworld-heading" className="text-lg font-semibold">
          Import from MakerWorld
        </h2>
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
          Paste a model page URL to bring its files and details into your library. Imports use the
          linked print profile, or the first available profile.
        </p>
      </div>
      {targets.length === 0 ? (
        <p className="text-sm text-[var(--color-ink-muted)]">
          <Link href="/admin/libraries/new" className="underline">
            Create a writable library
          </Link>{' '}
          to import models.
        </p>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            setError(null)
            startTransition(async () => {
              try {
                const result = await startMakerWorldImport({ libraryId, url })
                if (!result.ok) {
                  setError(result.error)
                  return
                }
                setImportId(result.id)
                setStatus({ state: 'queued', publicId: null, error: null })
                setPollError(null)
              } catch {
                setError('Could not start the import. Please try again.')
              }
            })
          }}
        >
          <label className="block space-y-1 text-sm">
            <span>Import to library</span>
            <select
              required
              value={libraryId}
              onChange={(event) => setLibraryId(event.target.value)}
              disabled={pending || active}
              className="h-10 w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3"
            >
              {targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1 text-sm">
            <span>MakerWorld model URL</span>
            <Input
              type="url"
              required
              placeholder="https://makerworld.com/en/models/…"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              disabled={pending || active}
            />
          </label>
          <Button type="submit" disabled={pending || active}>
            {pending ? 'Starting import…' : active ? 'Import in progress…' : 'Import model'}
          </Button>
        </form>
      )}
      <details className="rounded-[var(--radius-control)] border border-[var(--color-border)] p-3">
        <summary className="cursor-pointer text-sm font-medium">MakerWorld account cookie</summary>
        <div className="mt-3 space-y-3 text-sm">
          <p className="text-[var(--color-ink-muted)]">
            Save your MakerWorld token cookie to download print profiles. It is saved for your
            PrintBench account and never shown again.
          </p>
          <p>Cookie: {saved === null ? 'Status unavailable' : saved ? 'Saved' : 'Not saved'}</p>
          <label className="block space-y-1">
            <span>Account cookie</span>
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={cookie}
              onChange={(event) => setCookie(event.target.value)}
              disabled={cookiePending}
            />
          </label>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={cookiePending || !cookie.trim()}
              onClick={() => updateCookie(cookie)}
            >
              Save cookie
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={cookiePending || saved !== true}
              onClick={() => updateCookie('')}
            >
              Remove cookie
            </Button>
          </div>
          <p role="status">{cookieMessage}</p>
        </div>
      </details>
      {error && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}
      <div role="status" aria-live="polite" className="text-sm">
        {status?.state === 'queued' && <p>Queued. The import will start in the background.</p>}
        {status?.state === 'importing' && <p>Importing model files and details…</p>}
        {status?.state === 'complete' && (
          <p>
            Import complete.{' '}
            {status.publicId && (
              <Link className="underline" href={`/models/${encodeURIComponent(status.publicId)}`}>
                Open model
              </Link>
            )}
          </p>
        )}
        {status?.state === 'failed' && (
          <p className="text-[var(--color-danger)]">
            {status.error || 'The import failed. Please try again.'}
          </p>
        )}
      </div>
      {pollError && (
        <div role="alert" className="text-sm">
          <p>{pollError}</p>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setPollError(null)
              setPollAttempt((value) => value + 1)
            }}
          >
            Check again
          </Button>
        </div>
      )}
    </section>
  )
}
