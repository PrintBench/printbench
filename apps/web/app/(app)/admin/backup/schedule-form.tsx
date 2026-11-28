'use client'

import { useState, useTransition } from 'react'
import { CloudUpload, KeyRound, Loader2, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import {
  backUpNowAction,
  checkBackupPassphraseAction,
  removeBackupScheduleAction,
  saveBackupScheduleAction,
} from './actions'

/** What the page passes down. Never the key itself, sealed or not. */
export interface ScheduleFormValues {
  enabled: boolean
  s3ConnectionId: string
  prefix: string
  cron: string
  keep: number
  keyId: string
}

interface Props {
  existing: ScheduleFormValues | null
  connections: { id: string; name: string; bucket: string }[]
  presets: readonly { cron: string; label: string; hint: string }[]
  defaults: { prefix: string; keep: number; minPassphrase: number }
}

type Notice = { tone: 'ok' | 'error'; text: string } | null

/**
 * Sets up scheduled backups.
 *
 * The passphrase is asked for twice and never shown again: the server keeps
 * only a key sealed under it, so there is no "forgot passphrase" — which is
 * why the form also offers to check it, long before a restore depends on it.
 */
export function ScheduleForm({ existing, connections, presets, defaults }: Props) {
  const [enabled, setEnabled] = useState(existing?.enabled ?? true)
  const [connectionId, setConnectionId] = useState(
    existing?.s3ConnectionId ?? connections[0]?.id ?? '',
  )
  const [prefix, setPrefix] = useState(existing?.prefix ?? defaults.prefix)
  const [cron, setCron] = useState(existing?.cron ?? presets[0]!.cron)
  const [keep, setKeep] = useState(String(existing?.keep ?? defaults.keep))
  const [changeKey, setChangeKey] = useState(!existing)
  const [passphrase, setPassphrase] = useState('')
  const [repeat, setRepeat] = useState('')
  const [check, setCheck] = useState('')
  const [notice, setNotice] = useState<Notice>(null)
  const [checkNotice, setCheckNotice] = useState<Notice>(null)
  const [pending, startTransition] = useTransition()

  const [custom, setCustom] = useState(
    existing !== null && !presets.some((preset) => preset.cron === existing.cron),
  )
  const mismatch = repeat.length > 0 && passphrase !== repeat
  const tooShort = passphrase.length > 0 && passphrase.length < defaults.minPassphrase

  function report(result: { ok: true; message?: string } | { ok: false; error: string }) {
    setNotice(
      result.ok
        ? { tone: 'ok', text: result.message ?? 'Saved.' }
        : { tone: 'error', text: result.error },
    )
  }

  function save(event: React.FormEvent) {
    event.preventDefault()
    setNotice(null)
    if (changeKey && passphrase !== repeat) {
      return setNotice({ tone: 'error', text: 'The two passphrases do not match.' })
    }
    startTransition(async () => {
      const result = await saveBackupScheduleAction({
        enabled,
        s3ConnectionId: connectionId,
        prefix,
        cron,
        keep: Number(keep),
        passphrase: changeKey ? passphrase : null,
      })
      report(result)
      if (result.ok) {
        setPassphrase('')
        setRepeat('')
        setChangeKey(false)
      }
    })
  }

  if (connections.length === 0) {
    return (
      <p className="text-sm text-[var(--color-ink-muted)]">
        Add an S3 connection under{' '}
        <a className="underline" href="/admin/storage">
          Storage
        </a>{' '}
        first. Backups go to a folder of their own in one of its buckets.
      </p>
    )
  }

  return (
    <div className="space-y-6">
      <form onSubmit={save} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Bucket" htmlFor="backup-connection">
            <Select value={connectionId} onChange={(event) => setConnectionId(event.target.value)}>
              {connections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.name} ({connection.bucket})
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Folder"
            htmlFor="backup-prefix"
            hint="A prefix no library uses. Backups are written directly inside it."
          >
            <Input value={prefix} onChange={(event) => setPrefix(event.target.value)} />
          </Field>
          <Field
            label="How often"
            htmlFor="backup-cron"
            hint={
              custom
                ? 'A cron expression, in the server’s time zone. At most hourly.'
                : presets.find((preset) => preset.cron === cron)?.hint
            }
          >
            <Select
              value={custom ? 'custom' : cron}
              onChange={(event) => {
                const isCustom = event.target.value === 'custom'
                setCustom(isCustom)
                if (!isCustom) setCron(event.target.value)
              }}
            >
              {presets.map((preset) => (
                <option key={preset.cron} value={preset.cron}>
                  {preset.label}
                </option>
              ))}
              <option value="custom">Custom…</option>
            </Select>
          </Field>
          <Field
            label="Keep"
            htmlFor="backup-keep"
            hint="The newest backups to keep. Older ones are deleted after each successful backup."
          >
            <Input
              type="number"
              min={1}
              max={365}
              value={keep}
              onChange={(event) => setKeep(event.target.value)}
            />
          </Field>
          {custom && (
            <Field label="Cron expression" htmlFor="backup-cron-custom" className="sm:col-span-2">
              <Input value={cron} onChange={(event) => setCron(event.target.value)} />
            </Field>
          )}
        </div>

        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            className="mt-1"
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-[var(--color-ink)]">
              Run on schedule
            </span>
            <span className="block text-xs text-[var(--color-ink-faint)]">
              Untick to pause. “Back up now” still works while paused.
            </span>
          </span>
        </label>

        {existing && !changeKey ? (
          <p className="flex flex-wrap items-center gap-2 text-sm text-[var(--color-ink-muted)]">
            <KeyRound className="size-4" />
            Encrypted with key {existing.keyId.slice(0, 8)}.
            <Button type="button" variant="ghost" size="sm" onClick={() => setChangeKey(true)}>
              Change passphrase
            </Button>
          </p>
        ) : (
          <div className="space-y-4 rounded-[var(--radius-card)] border border-[var(--color-border)] p-4">
            <p className="text-sm text-[var(--color-ink-muted)]">
              {existing
                ? 'A new passphrase makes a new key. Backups already in the bucket keep needing the old passphrase.'
                : 'Every backup is encrypted. Restoring one needs this passphrase, and nothing else can open it: PrintBench does not keep it and cannot recover it.'}
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Passphrase"
                htmlFor="backup-passphrase"
                error={tooShort ? `At least ${defaults.minPassphrase} characters.` : undefined}
              >
                <Input
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
            {existing && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setChangeKey(false)}>
                Keep the current passphrase
              </Button>
            )}
          </div>
        )}

        {notice && (
          <p
            role={notice.tone === 'error' ? 'alert' : 'status'}
            className={
              notice.tone === 'error'
                ? 'text-sm text-[var(--color-danger)]'
                : 'text-sm text-[var(--color-success)]'
            }
          >
            {notice.text}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            disabled={pending || (changeKey && (!passphrase || mismatch || tooShort))}
          >
            {pending ? <Loader2 className="animate-spin" /> : <Save />}
            {existing ? 'Save' : 'Turn on scheduled backups'}
          </Button>
          {existing && (
            <>
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={() => startTransition(async () => report(await backUpNowAction()))}
              >
                <CloudUpload />
                Back up now
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  if (
                    !window.confirm(
                      'Turn off scheduled backups? Backups already in the bucket are kept, but the key is forgotten: setting up again means a new passphrase.',
                    )
                  ) {
                    return
                  }
                  startTransition(async () => report(await removeBackupScheduleAction()))
                }}
              >
                Turn off
              </Button>
            </>
          )}
        </div>
      </form>

      {existing && (
        <form
          className="space-y-2 border-t border-[var(--color-border)] pt-4"
          onSubmit={(event) => {
            event.preventDefault()
            setCheckNotice(null)
            startTransition(async () => {
              const result = await checkBackupPassphraseAction(check)
              setCheckNotice(
                result.ok
                  ? { tone: 'ok', text: result.message ?? 'It matches.' }
                  : { tone: 'error', text: result.error },
              )
              if (result.ok) setCheck('')
            })
          }}
        >
          <Field
            label="Check your passphrase"
            htmlFor="backup-passphrase-check"
            hint="Make sure you still have it while there is time to change it."
          >
            <Input
              type="password"
              autoComplete="off"
              value={check}
              onChange={(event) => setCheck(event.target.value)}
            />
          </Field>
          <Button type="submit" variant="secondary" size="sm" disabled={!check || pending}>
            Check
          </Button>
          {checkNotice && (
            <p
              role={checkNotice.tone === 'error' ? 'alert' : 'status'}
              className={
                checkNotice.tone === 'error'
                  ? 'text-sm text-[var(--color-danger)]'
                  : 'text-sm text-[var(--color-success)]'
              }
            >
              {checkNotice.text}
            </p>
          )}
        </form>
      )}
    </div>
  )
}
