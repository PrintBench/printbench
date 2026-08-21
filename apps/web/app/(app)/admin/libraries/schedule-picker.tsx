'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarClock, Check, Loader2 } from 'lucide-react'
import { SCHEDULE_PRESETS } from '@pb/core/schedule'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { updateLibrarySchedule, updateLibraryWatch } from './actions'

/**
 * When a library scans itself.
 *
 * Presets rather than a cron field, because "every 6 hours" is what people
 * actually want and `0 *\/6 * * *` is what they get wrong. The expression is
 * still reachable for anyone who wants it.
 *
 * Live watching is a second, independent mechanism shown in the same panel:
 * it is off by default and a schedule is still the reliable fallback, but
 * turning it on means an edit shows up within seconds rather than at the
 * next scheduled scan. Only offered for a local library — there is no
 * filesystem to watch on S3.
 */
export function SchedulePicker({
  libraryId,
  cron,
  enabled,
  nextRunLabel,
  watchable,
  watching,
}: {
  libraryId: string
  cron: string
  enabled: boolean
  /** Rendered on the server, so the two never disagree about the timezone. */
  nextRunLabel: string | null
  /** False for an S3-backed library, which has no filesystem to watch. */
  watchable: boolean
  watching: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(cron)
  const [custom, setCustom] = useState(
    cron !== '' && !SCHEDULE_PRESETS.some((preset) => preset.cron === cron),
  )
  const [scanEnabled, setScanEnabled] = useState(enabled)
  const [watchEnabled, setWatchEnabled] = useState(watching)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const current = SCHEDULE_PRESETS.find((preset) => preset.cron === cron)
  const label = cron === '' ? 'Manual only' : (current?.label ?? cron)

  function save() {
    setError(null)
    startTransition(async () => {
      const result = await updateLibrarySchedule(libraryId, {
        scanCron: value,
        scanEnabled,
      })
      if (!result.ok) {
        setError(result.error)
        return
      }
      if (watchable && watchEnabled !== watching) {
        const watchResult = await updateLibraryWatch(libraryId, watchEnabled)
        if (!watchResult.ok) {
          setError(watchResult.error)
          return
        }
      }
      setOpen(false)
      router.refresh()
    })
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
      >
        <CalendarClock className="size-3.5" />
        {enabled ? label : 'Scanning off'}
        {enabled && nextRunLabel && (
          <span className="text-[var(--color-ink-faint)]">· next {nextRunLabel}</span>
        )}
        {watching && <span className="text-[var(--color-ink-faint)]">· watching live</span>}
      </button>
    )
  }

  return (
    <div className="w-full space-y-2 rounded-[var(--radius-control)] border border-[var(--color-border)] p-3">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={scanEnabled}
          onChange={(e) => setScanEnabled(e.target.checked)}
        />
        Scan this library
      </label>

      {scanEnabled && (
        <>
          <Select
            value={custom ? 'custom' : value}
            onChange={(e) => {
              if (e.target.value === 'custom') {
                setCustom(true)
                return
              }
              setCustom(false)
              setValue(e.target.value)
            }}
          >
            {SCHEDULE_PRESETS.map((preset) => (
              <option key={preset.cron || 'manual'} value={preset.cron}>
                {preset.label}
              </option>
            ))}
            <option value="custom">Custom schedule…</option>
          </Select>

          {custom && (
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="0 3 * * *"
              aria-label="Cron expression"
              className="font-mono text-xs"
            />
          )}

          <p className="text-xs text-[var(--color-ink-faint)]">
            Times are the server&apos;s local time. Scheduled scans are fast scans — they trust
            directory timestamps. Run a deep scan by hand when you have edited files in place.
          </p>
        </>
      )}

      {watchable && (
        <label className="flex items-start gap-2 border-t border-[var(--color-border)] pt-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={watchEnabled}
            onChange={(e) => setWatchEnabled(e.target.checked)}
          />
          <span>
            Watch for changes live
            <span className="mt-0.5 block text-xs text-[var(--color-ink-faint)]">
              Scans within seconds of a file appearing, on top of the schedule above. Off by
              default: a very large library can use up the operating system&apos;s limit on how
              many folders it can watch at once.
            </span>
          </span>
        </label>
      )}

      {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}

      <div className="flex gap-2">
        <Button size="sm" onClick={save} disabled={pending}>
          {pending ? <Loader2 className="animate-spin" /> : <Check />}
          Save
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setOpen(false)
            setValue(cron)
            setError(null)
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  )
}
