'use client'

import { useRef, useState, useTransition } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field } from '@/components/ui/field'
import { createExportTicket } from './actions'

/**
 * Downloads a backup.
 *
 * The worker builds the file, so this posts a real form at it rather than
 * fetching: the browser streams the response straight to disk however large
 * it is, and the passphrase travels in the request body instead of a URL.
 */
export function ExportPanel({ managedLibraries }: { managedLibraries: number }) {
  const form = useRef<HTMLFormElement>(null)
  const [passphrase, setPassphrase] = useState('')
  const [repeat, setRepeat] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [started, setStarted] = useState(false)
  const [pending, startTransition] = useTransition()

  const mismatch = repeat.length > 0 && passphrase !== repeat

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setStarted(false)
    if (passphrase !== repeat) return setError('The two passphrases do not match.')

    startTransition(async () => {
      const issued = await createExportTicket()
      if (!issued.ok) return setError(issued.error)

      const target = form.current
      if (!target) return
      for (const [name, value] of Object.entries(issued.ticket)) {
        const field = target.elements.namedItem(name)
        if (field instanceof HTMLInputElement) field.value = value
      }
      // submit(), not requestSubmit(): this handler must not run a second time.
      target.submit()
      setStarted(true)
    })
  }

  return (
    <form
      ref={form}
      method="post"
      action="/api/backup/export"
      onSubmit={submit}
      className="space-y-4"
    >
      <input type="hidden" name="token" />
      <input type="hidden" name="expires" />
      <input type="hidden" name="subject" />

      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          name="includeFiles"
          defaultChecked={managedLibraries > 0}
          disabled={managedLibraries === 0}
          className="mt-0.5 size-4 accent-[var(--color-accent)]"
        />
        <span>
          <span className="font-medium">Include uploaded files</span>
          <span className="block text-[var(--color-ink-muted)]">
            {managedLibraries > 0
              ? 'The model files in libraries PrintBench stores uploads in. This can make the backup very large. Folders you pointed PrintBench at, and S3 libraries, are never copied.'
              : 'There are no upload libraries on local disk, so there is nothing to include.'}
          </span>
        </span>
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Passphrase (optional)"
          htmlFor="backup-passphrase"
          hint="Protects printer keys, S3 secrets and import sign-ins inside the backup. Without one they are left out and re-entered after a restore."
        >
          <Input
            name="passphrase"
            type="password"
            autoComplete="new-password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
          />
        </Field>
        <Field
          label="Repeat passphrase"
          htmlFor="backup-passphrase-repeat"
          error={mismatch ? 'Does not match.' : undefined}
        >
          <Input
            type="password"
            autoComplete="new-password"
            value={repeat}
            onChange={(event) => setRepeat(event.target.value)}
          />
        </Field>
      </div>

      {error && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}
      {started && (
        <p role="status" className="text-sm text-[var(--color-ink-muted)]">
          The download has started. Keep the passphrase somewhere safe: it cannot be recovered from
          the file.
        </p>
      )}

      <Button type="submit" disabled={pending || mismatch}>
        {pending ? <Loader2 className="animate-spin" /> : <Download />}
        Download backup
      </Button>
    </form>
  )
}
