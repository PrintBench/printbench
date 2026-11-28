'use client'

import { useState } from 'react'
import { CloudDownload, Loader2, Search, Upload } from 'lucide-react'
import type { RestoreSource } from '@pb/core'
import { BucketRows } from '@/components/backup/bucket-rows'
import { RestorePanel } from '@/components/backup/restore-panel'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/cn'
import type { BucketRow } from '@/lib/bucket-rows'
import { createFirstRunRestoreTicket, listRestoreSourceBackups } from './actions'

type Source = 'file' | 'bucket'

/**
 * The two ways a new server gets an old one's data: a file, or straight from
 * the bucket the old server's schedule wrote to.
 *
 * Switching between them unmounts the other, and with it anything it had
 * staged on the worker.
 */
export function FirstRunRestore({
  defaultPrefix,
  footer,
}: {
  defaultPrefix: string
  footer: React.ReactNode
}) {
  const [source, setSource] = useState<Source>('file')
  /*
   * Once restored, the way back out goes too: switching source would unmount
   * the "Go to sign in" step, and "start fresh instead" would offer to set up
   * an instance that now has accounts.
   */
  const [restored, setRestored] = useState(false)
  const done = () => setRestored(true)

  return (
    <div className="space-y-5">
      {!restored && (
        <div
          role="radiogroup"
          aria-label="Restore from"
          className="inline-flex rounded-[var(--radius-control)] border border-[var(--color-border)] p-0.5"
        >
          {(
            [
              { value: 'file', label: 'A backup file', Icon: Upload },
              { value: 'bucket', label: 'An S3 bucket', Icon: CloudDownload },
            ] as const
          ).map(({ value, label, Icon }) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={source === value}
              onClick={() => setSource(value)}
              className={cn(
                'flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-sm transition-colors',
                source === value
                  ? 'bg-[var(--color-surface-2)] font-medium text-[var(--color-ink)]'
                  : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
              )}
            >
              <Icon className="size-3.5" />
              {label}
            </button>
          ))}
        </div>
      )}

      {source === 'file' ? (
        <RestorePanel
          getTicket={createFirstRunRestoreTicket}
          firstRun
          footer={footer}
          onRestored={done}
        />
      ) : (
        <>
          <BucketSource defaultPrefix={defaultPrefix} onRestored={done} />
          {!restored && footer}
        </>
      )}
    </div>
  )
}

/** Every field as typed: blank rather than absent. */
type SourceForm = Record<keyof RestoreSource, string>

const EMPTY: SourceForm = {
  bucket: '',
  endpoint: '',
  region: '',
  accessKeyId: '',
  secretAccessKey: '',
  prefix: '',
}

/**
 * The bucket, typed in for this restore only.
 *
 * Nothing here is saved, on this server or in the browser: the credentials
 * live in this component's state, go to the server for the listing and to
 * the worker for the one fetch, and are gone when the page is. The restored
 * database brings the old server's S3 connection back with it.
 */
function BucketSource({
  defaultPrefix,
  onRestored,
}: {
  defaultPrefix: string
  onRestored: () => void
}) {
  const [form, setForm] = useState<SourceForm>({ ...EMPTY, prefix: defaultPrefix })
  // The source a listing came from, so a restore fetches with exactly what was listed.
  const [listed, setListed] = useState<{ source: RestoreSource; rows: BucketRow[] } | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [listing, setListing] = useState(false)

  function change(field: keyof RestoreSource, value: string) {
    setForm((current) => ({ ...current, [field]: value }))
    // A different bucket: whatever was listed, and any restore open from it, no longer applies.
    setListed(null)
    setOpen(null)
  }

  async function list() {
    setError(null)
    setListing(true)
    setOpen(null)
    try {
      const snapshot = { ...form }
      const result = await listRestoreSourceBackups(snapshot)
      if (result.ok) setListed({ source: snapshot, rows: result.rows })
      else {
        setListed(null)
        setError(result.error)
      }
    } catch {
      setError('Could not reach the server. Check the connection and try again.')
    } finally {
      setListing(false)
    }
  }

  const field = (name: keyof RestoreSource) => ({
    value: form[name],
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => change(name, event.target.value),
  })

  return (
    <div className="space-y-5">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (form.bucket.trim()) void list()
        }}
      >
        <p className="text-sm text-[var(--color-ink-muted)]">
          The bucket the old server’s scheduled backups were written to. These details are used for
          this restore only and are not saved; the restored instance brings its own S3 connection
          back.
        </p>
        {/* Held while a restore is open: Close it first, which discards what it staged. */}
        <fieldset disabled={open !== null || listing} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Bucket" htmlFor="source-bucket">
              <Input required autoComplete="off" spellCheck={false} {...field('bucket')} />
            </Field>
            <Field label="Region" htmlFor="source-region" hint="Optional. us-east-1 if blank.">
              <Input autoComplete="off" spellCheck={false} {...field('region')} />
            </Field>
          </div>
          <Field
            label="Endpoint"
            htmlFor="source-endpoint"
            hint="Leave blank for AWS. Otherwise the full URL, like https://s3.eu-central-003.backblazeb2.com."
          >
            <Input type="url" autoComplete="off" spellCheck={false} {...field('endpoint')} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Access key ID" htmlFor="source-access-key">
              <Input autoComplete="off" spellCheck={false} {...field('accessKeyId')} />
            </Field>
            <Field label="Secret access key" htmlFor="source-secret">
              <Input type="password" autoComplete="off" {...field('secretAccessKey')} />
            </Field>
          </div>
          <Field
            label="Prefix"
            htmlFor="source-prefix"
            hint="The folder the old server's schedule wrote to. Every instance's backups under it are listed."
          >
            <Input autoComplete="off" spellCheck={false} {...field('prefix')} />
          </Field>
        </fieldset>
        {error && (
          <p role="alert" className="text-sm text-[var(--color-danger)]">
            {error}
          </p>
        )}
        <Button type="submit" disabled={!form.bucket.trim() || listing || open !== null}>
          {listing ? <Loader2 className="animate-spin" /> : <Search />}
          {listing ? 'Looking…' : 'List backups'}
        </Button>
      </form>

      {listed && (
        <div className="border-t border-[var(--color-border)] pt-4">
          {listed.rows.length === 0 ? (
            <p className="text-sm text-[var(--color-ink-muted)]">
              No backups under {listed.source.bucket}/{listed.source.prefix || ''}. Check the prefix
              is the one the old server’s schedule used.
            </p>
          ) : (
            <>
              <h2 className="text-sm font-medium">
                {listed.rows.length === 1 ? '1 backup' : `${listed.rows.length} backups`}, newest
                first
              </h2>
              <p className="mb-1 text-xs text-[var(--color-ink-faint)]">
                Restoring one needs the passphrase its schedule used.
              </p>
              <BucketRows
                rows={listed.rows}
                open={open}
                setOpen={setOpen}
                getTicket={createFirstRunRestoreTicket}
                showInstance
                firstRun
                source={listed.source}
                onRestored={onRestored}
              />
            </>
          )}
        </div>
      )}
    </div>
  )
}
