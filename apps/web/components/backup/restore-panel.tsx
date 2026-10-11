'use client'

import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, ArchiveRestore, CheckCircle2, Loader2, Upload } from 'lucide-react'
import type { BackupTicket } from '@pb/core'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field } from '@/components/ui/field'
import { LocalTime } from '@/components/ui/local-time'

/** What the worker reports about an uploaded backup before anything is changed. */
interface Summary {
  appVersion: string | null
  createdAt: string
  rows: number
  counts: { users: number; models: number; libraries: number }
  files: { included: boolean; count: number; bytes: number }
  managedLibraries: number
  hasSecrets: boolean
  secretCount: number
}

type TicketResult = { ok: true; ticket: BackupTicket } | { ok: false; error: string }

type Step =
  | { name: 'pick' }
  | { name: 'uploading'; percent: number }
  | { name: 'review'; id: string; summary: Summary }
  | { name: 'restoring'; phase?: string }
  | { name: 'done' }

const PHASES: Record<string, string> = {
  checking: 'Checking the backup…',
  files: 'Copying uploaded files…',
  database: 'Loading the database…',
  upgrading: 'Bringing the data up to this version…',
}

const CONFIRM_WORD = 'RESTORE'
// Matches BACKUP_TICKET_HEADER in @pb/core, which is server code this file cannot import.
const TICKET_HEADER = 'x-printbench-backup-ticket'

/**
 * Restoring is three steps on purpose: upload, look at what the file holds,
 * then confirm. Nothing on this instance changes until the last one, so a
 * wrong file is a non-event rather than an accident.
 */
export function RestorePanel({
  getTicket,
  firstRun = false,
  footer,
}: {
  getTicket: () => Promise<TicketResult>
  /** Nothing exists yet to be replaced, so there is nothing to type to confirm. */
  firstRun?: boolean
  /** Shown only while choosing a file, where an alternative still makes sense. */
  footer?: React.ReactNode
}) {
  const [step, setStep] = useState<Step>({ name: 'pick' })
  const [error, setError] = useState<string | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // One ticket covers the upload, the restore and the polling after it — by
  // which point the session that could have issued another one is gone. Sent
  // as a header, so it stays out of URLs and the access logs that record them.
  const ticket = useRef('')
  const input = useRef<HTMLInputElement>(null)

  const restoring = step.name === 'restoring'
  useEffect(() => {
    if (!restoring) return
    let stopped = false

    async function poll() {
      try {
        const response = await fetch('/api/backup/restore/status', {
          cache: 'no-store',
          headers: { [TICKET_HEADER]: ticket.current },
        })
        const state = (await response.json()) as { status: string; phase?: string; error?: string }
        if (stopped) return
        if (state.status === 'done') setStep({ name: 'done' })
        else if (state.status === 'failed') {
          setError(state.error ?? 'The restore failed.')
          setStep({ name: 'pick' })
        } else setStep({ name: 'restoring', phase: state.phase })
      } catch {
        // The worker is busy or restarting. Keep asking.
      }
    }

    const timer = setInterval(() => void poll(), 1500)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [restoring])

  async function upload(file: File) {
    setError(null)
    const issued = await getTicket()
    if (!issued.ok) return setError(issued.error)
    ticket.current = new URLSearchParams({ ...issued.ticket }).toString()

    setStep({ name: 'uploading', percent: 0 })
    // XMLHttpRequest, because fetch still cannot report upload progress and a
    // backup with uploads in it can take a while.
    const request = new XMLHttpRequest()
    request.open('POST', '/api/backup/restore/upload')
    request.setRequestHeader(TICKET_HEADER, ticket.current)
    request.setRequestHeader('content-type', 'application/octet-stream')
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        setStep({ name: 'uploading', percent: Math.round((event.loaded / event.total) * 100) })
      }
    }
    request.onerror = () => {
      setError('The upload was interrupted. Check the connection and try again.')
      setStep({ name: 'pick' })
    }
    request.onload = () => {
      const body = parse(request.responseText) as { id?: string; summary?: Summary; error?: string }
      if (request.status === 200 && body.id && body.summary) {
        setPassphrase('')
        setConfirm('')
        setStep({ name: 'review', id: body.id, summary: body.summary })
      } else {
        setError(body.error ?? 'That file could not be read as a backup.')
        setStep({ name: 'pick' })
      }
    }
    request.send(file)
  }

  async function apply(id: string) {
    setError(null)
    setSubmitting(true)
    try {
      const response = await fetch('/api/backup/restore/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json', [TICKET_HEADER]: ticket.current },
        body: JSON.stringify({ id, passphrase }),
      })
      if (response.status === 202) return setStep({ name: 'restoring' })
      const body = parse(await response.text()) as { error?: string }
      setError(body.error ?? 'The restore could not be started.')
    } catch {
      setError('The restore could not be started. Check the connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (step.name === 'done') {
    return (
      <div className="space-y-4">
        <p className="flex items-start gap-2 text-sm">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[var(--color-success)]" />
          <span>
            Restored. This instance now holds what the backup held. Sign in with an account from the
            backup; thumbnails will reappear as they are re-rendered.
          </span>
        </p>
        {/* A full navigation, not a client one: the session cookie in this tab
            belongs to a database that no longer exists. */}
        <Button asChild>
          <a href="/login">Go to sign in</a>
        </Button>
      </div>
    )
  }

  if (step.name === 'restoring') {
    return (
      <div className="space-y-2" role="status">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Loader2 className="size-4 animate-spin" />
          {PHASES[step.phase ?? ''] ?? 'Restoring…'}
        </p>
        <p className="text-sm text-[var(--color-ink-muted)]">
          Keep this page open. The rest of PrintBench is unavailable until this finishes.
        </p>
      </div>
    )
  }

  if (step.name === 'review') {
    const { summary, id } = step
    const ready = firstRun || confirm.trim().toUpperCase() === CONFIRM_WORD

    return (
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (ready) void apply(id)
        }}
      >
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-[var(--color-ink-muted)]">Taken</dt>
          <dd>
            <LocalTime value={summary.createdAt} />
            {summary.appVersion && (
              <span className="text-[var(--color-ink-muted)]">
                {' '}
                · PrintBench {summary.appVersion}
              </span>
            )}
          </dd>
          <dt className="text-[var(--color-ink-muted)]">Contains</dt>
          <dd>
            {plural(summary.counts.models, 'model')},{' '}
            {plural(summary.counts.libraries, 'library', 'libraries')},{' '}
            {plural(summary.counts.users, 'account')}
          </dd>
          <dt className="text-[var(--color-ink-muted)]">Uploaded files</dt>
          <dd>
            {summary.files.included
              ? `${plural(summary.files.count, 'file')} (${formatBytes(summary.files.bytes)})`
              : summary.managedLibraries > 0
                ? 'Not included. Copy the upload folders across yourself, or those models will show as missing.'
                : 'None to include'}
          </dd>
          <dt className="text-[var(--color-ink-muted)]">Credentials</dt>
          <dd>
            {summary.hasSecrets
              ? `${plural(summary.secretCount, 'stored credential')}, protected by a passphrase`
              : 'Not included. Printer keys, S3 secrets and import sign-ins will need re-entering.'}
          </dd>
        </dl>

        {summary.hasSecrets && (
          <Field
            label="Backup passphrase"
            htmlFor="restore-passphrase"
            hint="The one chosen when this backup was made. Leave it empty to restore without the stored credentials."
          >
            <Input
              type="password"
              autoComplete="off"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
            />
          </Field>
        )}

        {!firstRun && (
          <>
            <p className="flex items-start gap-2 rounded-[var(--radius-card)] border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-4 py-3 text-sm text-[var(--color-danger)]">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                This replaces everything on this instance: every account, model record, tag, print
                and setting. Everyone is signed out, including you. It cannot be undone, so download
                a backup of this instance first if you might want it back.
              </span>
            </p>
            <Field label={`Type ${CONFIRM_WORD} to confirm`} htmlFor="restore-confirm">
              <Input
                autoComplete="off"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
              />
            </Field>
          </>
        )}

        {error && (
          <p role="alert" className="text-sm text-[var(--color-danger)]">
            {error}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            variant={firstRun ? 'primary' : 'danger'}
            disabled={!ready || submitting}
          >
            {submitting ? <Loader2 className="animate-spin" /> : <ArchiveRestore />}
            {firstRun ? 'Restore this backup' : 'Replace this instance'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={submitting}
            onClick={() => {
              setError(null)
              setStep({ name: 'pick' })
            }}
          >
            Choose a different file
          </Button>
        </div>
      </form>
    )
  }

  const uploading = step.name === 'uploading'
  return (
    <div className="space-y-3">
      <input
        ref={input}
        type="file"
        accept=".pbbackup"
        className="sr-only"
        aria-label="Backup file"
        onChange={(event) => {
          const file = event.target.files?.[0]
          // Cleared so choosing the same file again after an error still fires.
          event.target.value = ''
          if (file) void upload(file)
        }}
      />
      <Button
        type="button"
        variant={firstRun ? 'primary' : 'secondary'}
        disabled={uploading}
        onClick={() => input.current?.click()}
      >
        {uploading ? <Loader2 className="animate-spin" /> : <Upload />}
        {uploading ? `Uploading… ${step.percent}%` : 'Choose a backup file'}
      </Button>
      <p className="text-xs text-[var(--color-ink-faint)]">
        A .pbbackup file downloaded from PrintBench. Nothing changes until you have seen what it
        contains and confirmed.
      </p>
      {error && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}
      {footer}
    </div>
  )
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(unit === 0 || value >= 100 ? 0 : 1)} ${units[unit]}`
}
