'use client'

import { useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  pollMakerWorldImport,
  startModelSourceImport,
  type MakerWorldImportStatus,
} from './source-actions'
import { readMakerWorldCookieStatus } from '../settings/makerworld-actions'
import { readThingiverseTokenStatus } from '../settings/thingiverse-actions'

export function ModelSourceImportForm({
  libraryId,
  onBusyChange,
}: {
  libraryId: string
  onBusyChange: (busy: boolean) => void
}) {
  const router = useRouter()
  const [url, setUrl] = useState('')
  const [saved, setSaved] = useState<boolean | null>(null)
  const [thingiverseSaved, setThingiverseSaved] = useState<boolean | null>(null)
  const [cookieMessage, setCookieMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [importId, setImportId] = useState<string | null>(null)
  const [status, setStatus] = useState<MakerWorldImportStatus | null>(null)
  const [pending, startTransition] = useTransition()
  const [pollAttempt, setPollAttempt] = useState(0)
  const [pollError, setPollError] = useState<string | null>(null)
  const active = status?.state === 'queued' || status?.state === 'importing'

  useEffect(() => {
    onBusyChange(pending || active)
  }, [pending, active, onBusyChange])

  let source = ''
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
    if (['makerworld.com', 'printables.com', 'thingiverse.com'].includes(host)) source = host
  } catch {
    /* Connection help appears once a supported URL is entered. */
  }

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
    void readThingiverseTokenStatus()
      .then((result) => {
        if (cancelled) return
        if (result.ok) setThingiverseSaved(result.saved)
      })
      .catch(() => {
        // A connection check does not prevent importing from another source.
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

  return (
    <section aria-labelledby="model-sources-heading" className="space-y-3">
      <div>
        <h2 id="model-sources-heading" className="text-lg font-semibold">
          Import a model link
        </h2>
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
          Bring files and details from MakerWorld, Printables, or Thingiverse.
        </p>
      </div>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          setError(null)
          startTransition(async () => {
            try {
              const result = await startModelSourceImport({ libraryId, url })
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
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <label className="block flex-1 text-sm">
            <span className="block pb-2">Model page URL</span>
            <Input
              type="url"
              required
              placeholder="Paste a MakerWorld, Printables, or Thingiverse URL"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              disabled={pending || active}
            />
          </label>
          <Button type="submit" disabled={pending || active || !url.trim()} className="shrink-0">
            {pending ? 'Starting import…' : active ? 'Import in progress…' : 'Import model'}
          </Button>
        </div>
      </form>
      {source === 'makerworld.com' && (
        <p className="text-sm text-[var(--color-ink-muted)]">
          {cookieMessage ||
            (saved === null
              ? 'Checking MakerWorld connection…'
              : saved
                ? 'MakerWorld connection saved.'
                : 'Connect your Bambu account to download MakerWorld print profiles.')}{' '}
          <Link href="/settings#makerworld" className="underline">
            {saved ? 'Manage connection' : 'Set up MakerWorld'}
          </Link>
        </p>
      )}
      {source === 'printables.com' && (
        <p className="text-sm text-[var(--color-ink-muted)]">
          Public free Printables models need no account connection.
        </p>
      )}
      {source === 'thingiverse.com' && (
        <p className="text-sm text-[var(--color-ink-muted)]">
          {thingiverseSaved === null
            ? 'Thingiverse connection status unavailable.'
            : thingiverseSaved
              ? 'Thingiverse API token saved.'
              : 'Thingiverse needs an API token.'}{' '}
          <Link href="/settings#thingiverse" className="underline">
            {thingiverseSaved ? 'Manage connection' : 'Set up Thingiverse'}
          </Link>
        </p>
      )}
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
