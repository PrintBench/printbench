'use client'

import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArchiveRestore,
  CheckCircle2,
  CloudDownload,
  Loader2,
  LockKeyhole,
  Upload,
} from 'lucide-react'
import type { BackupTicket, RestoreSource } from '@pb/core'
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
  /** Absent from a backup taken before photographs existed. */
  photos?: { count: number; bytes: number }
  managedLibraries: number
  hasSecrets: boolean
  secretCount: number
}

/** What an encrypted backup says about itself before its passphrase is given. */
interface Locked {
  createdAt: string
  appVersion: string | null
  keyId: string
}

type TicketResult = { ok: true; ticket: BackupTicket } | { ok: false; error: string }

type Step =
  | { name: 'pick' }
  | { name: 'uploading'; percent: number }
  | { name: 'fetching' }
  | { name: 'unlock'; id: string; locked: Locked }
  | { name: 'review'; id: string; summary: Summary; encrypted: boolean }
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
 *
 * An encrypted backup — one written to a bucket on a schedule — has a fourth,
 * between the upload and the look: its passphrase, without which there is
 * nothing to look at.
 */
export function RestorePanel({
  getTicket,
  firstRun = false,
  footer,
  bucketBackup,
  bucketSource,
  onRestored,
}: {
  getTicket: () => Promise<TicketResult>
  /** Nothing exists yet to be replaced, so there is nothing to type to confirm. */
  firstRun?: boolean
  /** Shown only while choosing a file, where an alternative still makes sense. */
  footer?: React.ReactNode
  /** Restore this backup from the schedule's bucket instead of asking for a file. */
  bucketBackup?: string
  /**
   * Fetch `bucketBackup` from this bucket instead of the schedule's: the
   * first-run screen, where there is no schedule. Sent to the worker in the
   * request body for the one fetch, and kept nowhere else.
   */
  bucketSource?: RestoreSource
  /**
   * Called once the restore has finished. Whatever surrounds the panel —
   * a Close button, a "start fresh instead" link — then describes an
   * instance that no longer exists, so the parent hides it.
   */
  onRestored?: () => void
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
  /*
   * The upload the worker is holding for this panel, if any. Backing out —
   * cancelling, closing the panel, leaving the page — tells the worker to
   * delete it, decrypted copy and all. Cleared once a restore starts, because
   * the restore then owns the file and removes it itself.
   */
  const held = useRef<string | null>(null)

  useEffect(() => {
    const leave = () => discardHeld(held, ticket)
    window.addEventListener('pagehide', leave)
    return () => {
      window.removeEventListener('pagehide', leave)
      leave()
    }
  }, [])
  const input = useRef<HTMLInputElement>(null)
  // Read through a ref: the polling effect below outlives the render that set it up.
  const restoredCallback = useRef(onRestored)
  restoredCallback.current = onRestored

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
        if (state.status === 'done') {
          setStep({ name: 'done' })
          restoredCallback.current?.()
        } else if (state.status === 'failed') {
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
      const body = parse(request.responseText) as Staged
      if (request.status === 200 && body.id && (body.summary || body.locked)) {
        staged(body)
      } else {
        setError(body.error ?? 'That file could not be read as a backup.')
        setStep({ name: 'pick' })
      }
    }
    request.send(file)
  }

  /** Where an upload or a fetch lands: the passphrase first if it is encrypted. */
  function backOut() {
    discardHeld(held, ticket)
    setError(null)
    setPassphrase('')
    setStep({ name: 'pick' })
  }

  function staged(body: Staged) {
    held.current = body.id ?? null
    setPassphrase('')
    setConfirm('')
    if (body.locked) setStep({ name: 'unlock', id: body.id!, locked: body.locked })
    else setStep({ name: 'review', id: body.id!, summary: body.summary!, encrypted: false })
  }

  async function fetchFromBucket(name: string) {
    setError(null)
    const issued = await getTicket()
    if (!issued.ok) return setError(issued.error)
    ticket.current = new URLSearchParams({ ...issued.ticket }).toString()

    setStep({ name: 'fetching' })
    try {
      const response = await fetch('/api/backup/restore/fetch', {
        method: 'POST',
        headers: { 'content-type': 'application/json', [TICKET_HEADER]: ticket.current },
        body: JSON.stringify({ path: name, source: bucketSource }),
      })
      const body = parse(await response.text()) as Staged
      if (response.ok && body.id && (body.locked || body.summary)) return staged(body)
      setError(body.error ?? 'That backup could not be fetched from the bucket.')
    } catch {
      setError('The backup could not be fetched. Check the connection and try again.')
    }
    setStep({ name: 'pick' })
  }

  async function unlock(id: string) {
    setError(null)
    setSubmitting(true)
    try {
      const response = await fetch('/api/backup/restore/unlock', {
        method: 'POST',
        headers: { 'content-type': 'application/json', [TICKET_HEADER]: ticket.current },
        body: JSON.stringify({ id, passphrase }),
      })
      const body = parse(await response.text()) as Staged
      if (response.ok && body.id && body.summary) {
        // The passphrase stays in this component: applying needs it again, to
        // open the credentials inside. It never leaves except to the worker.
        return setStep({ name: 'review', id: body.id, summary: body.summary, encrypted: true })
      }
      setError(body.error ?? 'The backup could not be decrypted.')
    } catch {
      setError('The backup could not be decrypted. Check the connection and try again.')
    } finally {
      setSubmitting(false)
    }
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
      if (response.status === 202) {
        held.current = null
        return setStep({ name: 'restoring' })
      }
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

  if (step.name === 'fetching') {
    return (
      <p className="flex items-center gap-2 text-sm" role="status">
        <Loader2 className="size-4 animate-spin" />
        Fetching the backup from the bucket…
      </p>
    )
  }

  if (step.name === 'unlock') {
    const { locked, id } = step
    return (
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (passphrase) void unlock(id)
        }}
      >
        <p className="flex items-start gap-2 text-sm">
          <LockKeyhole className="mt-0.5 size-4 shrink-0" />
          <span>
            An encrypted backup taken <LocalTime value={locked.createdAt} />
            {locked.appVersion ? ` by PrintBench ${locked.appVersion}` : ''}. Enter its passphrase
            to see what it holds. Nothing changes yet.
          </span>
        </p>
        <Field
          label="Backup passphrase"
          htmlFor="unlock-passphrase"
          hint={`The passphrase scheduled backups used when this was taken (key ${locked.keyId.slice(0, 8)}).`}
        >
          <Input
            type="password"
            autoComplete="off"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
          />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-[var(--color-danger)]">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!passphrase || submitting}>
            {submitting ? <Loader2 className="animate-spin" /> : <LockKeyhole />}
            {submitting ? 'Decrypting…' : 'Unlock'}
          </Button>
          <Button type="button" variant="ghost" disabled={submitting} onClick={backOut}>
            Cancel
          </Button>
        </div>
      </form>
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
    const { summary, id, encrypted } = step
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
          <dt className="text-[var(--color-ink-muted)]">Photos</dt>
          <dd>
            {summary.photos && summary.photos.count > 0
              ? `${plural(summary.photos.count, 'image')} (${formatBytes(summary.photos.bytes)})`
              : 'None to include'}
          </dd>
          <dt className="text-[var(--color-ink-muted)]">Credentials</dt>
          <dd>
            {summary.hasSecrets
              ? `${plural(summary.secretCount, 'stored credential')}, protected by ${encrypted ? 'the passphrase you entered' : 'a passphrase'}`
              : 'Not included. Printer keys, S3 secrets and import sign-ins will need re-entering.'}
          </dd>
        </dl>

        {summary.hasSecrets && !encrypted && (
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
          <Button type="button" variant="ghost" disabled={submitting} onClick={backOut}>
            {bucketBackup ? 'Cancel' : 'Choose a different file'}
          </Button>
        </div>
      </form>
    )
  }

  if (bucketBackup) {
    return (
      <div className="space-y-3">
        <Button
          type="button"
          variant="secondary"
          onClick={() => void fetchFromBucket(bucketBackup)}
        >
          <CloudDownload />
          Fetch this backup
        </Button>
        <p className="text-xs text-[var(--color-ink-faint)]">
          Copies it from the bucket and asks for its passphrase. Nothing changes until you have seen
          what it contains and confirmed.
        </p>
        {error && (
          <p role="alert" className="text-sm text-[var(--color-danger)]">
            {error}
          </p>
        )}
      </div>
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
        A .pbbackup file downloaded from PrintBench, or an encrypted one copied out of a backup
        bucket. Nothing changes until you have seen what it contains and confirmed.
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

/**
 * Tells the worker to delete the upload this panel holds. Fire and forget,
 * with keepalive so it still arrives as the page unloads; the worker also
 * sweeps anything left for an hour, for a tab that crashed instead.
 */
function discardHeld(held: React.RefObject<string | null>, ticket: React.RefObject<string>): void {
  const id = held.current
  held.current = null
  if (!id || !ticket.current) return
  void fetch('/api/backup/restore/discard', {
    method: 'POST',
    keepalive: true,
    headers: { 'content-type': 'application/json', [TICKET_HEADER]: ticket.current },
    body: JSON.stringify({ id }),
  }).catch(() => undefined)
}

/** What the worker answers after an upload, a fetch or an unlock. */
interface Staged {
  id?: string
  summary?: Summary
  locked?: Locked
  error?: string
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
