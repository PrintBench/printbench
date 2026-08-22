'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  CheckCircle2,
  CircleDashed,
  Loader2,
  Pencil,
  Plus,
  Star,
  Trash2,
  XCircle,
} from 'lucide-react'
import type { PrintStatus } from '@pb/core'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Field } from '@/components/ui/field'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/cn'
import { editPrint, recordPrint, removePrint, type PrintFormInput } from './print-actions'

/**
 * Print history for one model.
 *
 * The point of this feature is the second print, not the first: what layer
 * height worked, which material warped, whether the supports were worth it. So
 * the timeline shows settings alongside the outcome rather than hiding them
 * behind a detail view.
 */

export interface PrintRunView {
  id: string
  filename: string | null
  userName: string | null
  printerName: string | null
  material: string | null
  colorHex: string | null
  layerHeightMm: number | null
  nozzleMm: number | null
  status: PrintStatus
  startedAt: string | null
  finishedAt: string | null
  durationMin: number | null
  filamentUsedG: number | null
  rating: number | null
  notes: string | null
  createdAt: string
}

export interface PrintStatsView {
  total: number
  successes: number
  failures: number
  successRate: number | null
  lastPrintedAt: string | null
  totalFilamentG: number
  totalDurationMin: number
}

interface Props {
  publicId: string
  prints: PrintRunView[]
  stats: PrintStatsView
  files: { id: string; filename: string }[]
  suggestions: { materials: string[]; printers: string[] }
  canLog: boolean
}

const STATUS_META: Record<
  PrintStatus,
  { label: string; icon: typeof CheckCircle2; class: string }
> = {
  success: { label: 'Success', icon: CheckCircle2, class: 'text-[var(--color-success)]' },
  failed: { label: 'Failed', icon: XCircle, class: 'text-[var(--color-danger)]' },
  partial: { label: 'Partial', icon: CircleDashed, class: 'text-[var(--color-warning)]' },
  in_progress: { label: 'Printing', icon: Loader2, class: 'text-[var(--color-accent)]' },
}

export function PrintHistory({ publicId, prints, stats, files, suggestions, canLog }: Props) {
  const router = useRouter()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<PrintRunView | null>(null)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function close() {
    setFormOpen(false)
    setEditing(null)
    setError(null)
  }

  function submit(input: PrintFormInput) {
    setError(null)
    startTransition(async () => {
      const result = editing
        ? await editPrint(publicId, editing.id, input)
        : await recordPrint(publicId, input)

      if (!result.ok) {
        setError(result.error)
        return
      }
      close()
      router.refresh()
    })
  }

  function remove(print: PrintRunView) {
    if (!confirm('Delete this print from the history? This cannot be undone.')) return
    startTransition(async () => {
      const result = await removePrint(publicId, print.id)
      if (!result.ok) setError(result.error)
      else router.refresh()
    })
  }

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold">Print history</h2>
        <PrintSummary stats={stats} />
        {canLog && !formOpen && (
          <Button
            variant="secondary"
            size="sm"
            className="ml-auto"
            onClick={() => setFormOpen(true)}
          >
            <Plus />
            Log a print
          </Button>
        )}
      </div>

      {error && !formOpen && <p className="mb-2 text-sm text-[var(--color-danger)]">{error}</p>}

      {(formOpen || editing) && (
        <Card className="mb-3">
          <CardContent className="p-4">
            <PrintForm
              key={editing?.id ?? 'new'}
              initial={editing}
              files={files}
              suggestions={suggestions}
              pending={pending}
              error={error}
              onCancel={close}
              onSubmit={submit}
            />
          </CardContent>
        </Card>
      )}

      {prints.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center text-sm text-[var(--color-ink-muted)]">
            Never printed.
            {canLog &&
              ' Log one once it comes off the plate — settings that worked are worth keeping.'}
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ol className="divide-y divide-[var(--color-border)]">
            {prints.map((print) => (
              <PrintRow
                key={print.id}
                print={print}
                canEdit={canLog}
                onEdit={() => {
                  setEditing(print)
                  setFormOpen(false)
                  setError(null)
                }}
                onDelete={() => remove(print)}
              />
            ))}
          </ol>
        </Card>
      )}
    </section>
  )
}

function PrintSummary({ stats }: { stats: PrintStatsView }) {
  if (stats.total === 0) return null

  return (
    <p className="text-xs text-[var(--color-ink-muted)]">
      Printed {stats.total}
      {stats.total === 1 ? ' time' : ' times'}
      {/*
       * Null, not zero: a model whose only print is still running has no
       * verdict yet, and showing 0% would read as a failure.
       */}
      {stats.successRate != null && ` · ${Math.round(stats.successRate * 100)}% success`}
      {stats.lastPrintedAt && ` · last ${formatDate(stats.lastPrintedAt)}`}
      {stats.totalFilamentG > 0 && ` · ${formatGrams(stats.totalFilamentG)} filament`}
    </p>
  )
}

function PrintRow({
  print,
  canEdit,
  onEdit,
  onDelete,
}: {
  print: PrintRunView
  canEdit: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const meta = STATUS_META[print.status]
  const Icon = meta.icon

  const settings = [
    print.printerName,
    print.material,
    print.layerHeightMm != null && `${print.layerHeightMm} mm layers`,
    print.nozzleMm != null && `${print.nozzleMm} mm nozzle`,
    print.durationMin != null && formatDuration(print.durationMin),
    print.filamentUsedG != null && formatGrams(print.filamentUsedG),
  ].filter(Boolean) as string[]

  return (
    <li className="flex gap-3 px-4 py-3">
      <Icon
        className={cn(
          'mt-0.5 size-4 shrink-0',
          meta.class,
          print.status === 'in_progress' && 'animate-spin',
        )}
        aria-hidden
      />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
          <span className="font-medium">{meta.label}</span>
          <span className="text-[var(--color-ink-faint)]">
            {formatDate(print.startedAt ?? print.createdAt)}
          </span>
          {print.rating != null && <Rating value={print.rating} />}
          {print.colorHex && (
            <span
              className="size-3 rounded-full ring-1 ring-inset ring-[var(--color-border)]"
              style={{ backgroundColor: print.colorHex }}
              title={print.colorHex}
            />
          )}
        </div>

        {settings.length > 0 && (
          <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">{settings.join(' · ')}</p>
        )}
        {print.filename && (
          <p className="mt-0.5 truncate font-mono text-xs text-[var(--color-ink-faint)]">
            {print.filename}
          </p>
        )}
        {print.notes && (
          <p className="mt-1 whitespace-pre-wrap text-sm text-[var(--color-ink-muted)]">
            {print.notes}
          </p>
        )}
        {print.userName && (
          <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">by {print.userName}</p>
        )}
      </div>

      {canEdit && (
        <div className="flex shrink-0 gap-1">
          <Button variant="ghost" size="icon" onClick={onEdit} aria-label="Edit this print">
            <Pencil />
          </Button>
          <Button variant="ghost" size="icon" onClick={onDelete} aria-label="Delete this print">
            <Trash2 />
          </Button>
        </div>
      )}
    </li>
  )
}

function Rating({ value }: { value: number }) {
  return (
    <span className="flex items-center gap-0.5" aria-label={`Rated ${value} out of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          aria-hidden
          className={cn(
            'size-3',
            n <= value
              ? 'fill-[var(--color-warning)] text-[var(--color-warning)]'
              : 'text-[var(--color-ink-faint)]',
          )}
        />
      ))}
    </span>
  )
}

function PrintForm({
  initial,
  files,
  suggestions,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  initial: PrintRunView | null
  files: { id: string; filename: string }[]
  suggestions: { materials: string[]; printers: string[] }
  pending: boolean
  error: string | null
  onCancel: () => void
  onSubmit: (input: PrintFormInput) => void
}) {
  const [status, setStatus] = useState<PrintStatus>(initial?.status ?? 'success')
  const [modelFileId, setModelFileId] = useState(initial?.filename ? findFile(files, initial) : '')
  const [printerName, setPrinterName] = useState(
    initial?.printerName ?? suggestions.printers[0] ?? '',
  )
  const [material, setMaterial] = useState(initial?.material ?? suggestions.materials[0] ?? '')
  const [colorHex, setColorHex] = useState(initial?.colorHex ?? '')
  const [layerHeight, setLayerHeight] = useState(initial?.layerHeightMm?.toString() ?? '')
  const [nozzle, setNozzle] = useState(initial?.nozzleMm?.toString() ?? '')
  const [startedAt, setStartedAt] = useState(
    toLocalInput(initial?.startedAt) || toLocalInput(new Date().toISOString()),
  )
  const [finishedAt, setFinishedAt] = useState(toLocalInput(initial?.finishedAt))
  const [duration, setDuration] = useState(initial?.durationMin?.toString() ?? '')
  const [filament, setFilament] = useState(initial?.filamentUsedG?.toString() ?? '')
  const [rating, setRating] = useState<number | null>(initial?.rating ?? null)
  const [notes, setNotes] = useState(initial?.notes ?? '')

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    onSubmit({
      modelFileId: modelFileId || null,
      printerName: printerName || null,
      material: material || null,
      colorHex: colorHex || null,
      layerHeightMm: numberOrNull(layerHeight),
      nozzleMm: numberOrNull(nozzle),
      status,
      startedAt: startedAt ? new Date(startedAt).toISOString() : null,
      finishedAt: finishedAt ? new Date(finishedAt).toISOString() : null,
      // Left blank, the duration is derived from the two timestamps server-side.
      durationMin: numberOrNull(duration),
      filamentUsedG: numberOrNull(filament),
      rating,
      notes: notes || null,
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Outcome" htmlFor="print-status">
          <Select value={status} onChange={(e) => setStatus(e.target.value as PrintStatus)}>
            <option value="success">Success</option>
            <option value="partial">Partial — usable, with problems</option>
            <option value="failed">Failed</option>
            <option value="in_progress">Still printing</option>
          </Select>
        </Field>

        {files.length > 0 && (
          <Field label="File printed" htmlFor="print-file" hint="Optional">
            <Select value={modelFileId} onChange={(e) => setModelFileId(e.target.value)}>
              <option value="">Not recorded</option>
              {files.map((file) => (
                <option key={file.id} value={file.id}>
                  {file.filename}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <Field label="Printer" htmlFor="print-printer">
          <Input
            list="printer-suggestions"
            value={printerName}
            onChange={(e) => setPrinterName(e.target.value)}
            placeholder="Bambu P1S"
          />
        </Field>
        <datalist id="printer-suggestions">
          {suggestions.printers.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>

        <Field label="Material" htmlFor="print-material">
          <Input
            list="material-suggestions"
            value={material}
            onChange={(e) => setMaterial(e.target.value)}
            placeholder="PLA"
          />
        </Field>
        <datalist id="material-suggestions">
          {suggestions.materials.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>

        {/*
         * Not a Field: it clones the id onto its single child, which here is
         * the wrapper, leaving two elements sharing one id. Two controls
         * behind one label needs the label written out.
         */}
        <div className="space-y-1.5">
          <label
            htmlFor="print-colour"
            className="block text-sm font-medium text-[var(--color-ink)]"
          >
            Colour
          </label>
          <div className="flex gap-2">
            <input
              type="color"
              aria-label="Filament colour"
              value={colorHex || '#4a5568'}
              onChange={(e) => setColorHex(e.target.value)}
              className="h-10 w-12 shrink-0 cursor-pointer rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] p-1"
            />
            <Input
              id="print-colour"
              value={colorHex}
              onChange={(e) => setColorHex(e.target.value)}
              placeholder="#1a2b3c"
            />
          </div>
          <p className="text-xs text-[var(--color-ink-faint)]">Optional</p>
        </div>

        <Field label="Layer height (mm)" htmlFor="print-layer">
          <Input
            type="number"
            step="0.01"
            min="0.01"
            max="5"
            value={layerHeight}
            onChange={(e) => setLayerHeight(e.target.value)}
            placeholder="0.2"
          />
        </Field>

        <Field label="Nozzle (mm)" htmlFor="print-nozzle">
          <Input
            type="number"
            step="0.1"
            min="0.1"
            value={nozzle}
            onChange={(e) => setNozzle(e.target.value)}
            placeholder="0.4"
          />
        </Field>

        <Field label="Started" htmlFor="print-started">
          <Input
            type="datetime-local"
            value={startedAt}
            onChange={(e) => setStartedAt(e.target.value)}
          />
        </Field>

        <Field label="Finished" htmlFor="print-finished" hint="Leave blank while it runs">
          <Input
            type="datetime-local"
            value={finishedAt}
            onChange={(e) => setFinishedAt(e.target.value)}
          />
        </Field>

        <Field
          label="Duration (min)"
          htmlFor="print-duration"
          hint="Worked out from the times if blank"
        >
          <Input
            type="number"
            min="0"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
          />
        </Field>

        <Field label="Filament used (g)" htmlFor="print-filament">
          <Input
            type="number"
            step="0.1"
            min="0"
            value={filament}
            onChange={(e) => setFilament(e.target.value)}
          />
        </Field>

        <div className="space-y-1.5">
          <span className="block text-sm font-medium text-[var(--color-ink)]">
            How did it come out?
          </span>
          <div className="flex h-10 items-center gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                aria-label={`${n} out of 5`}
                aria-pressed={rating != null && n <= rating}
                // Clicking the current rating clears it: there is no other way
                // back to "no opinion" once a star has been pressed.
                onClick={() => setRating(rating === n ? null : n)}
                className="rounded p-0.5 hover:bg-[var(--color-surface-2)]"
              >
                <Star
                  className={cn(
                    'size-5',
                    rating != null && n <= rating
                      ? 'fill-[var(--color-warning)] text-[var(--color-warning)]'
                      : 'text-[var(--color-ink-faint)]',
                  )}
                />
              </button>
            ))}
          </div>
        </div>
      </div>

      <Field label="Notes" htmlFor="print-notes" hint="Anything worth knowing next time">
        <textarea
          id="print-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="Brim helped with warping. Slowed the first layer to 20 mm/s."
          className="w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-ink)] placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-accent)]"
        />
      </Field>

      {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending && <Loader2 className="animate-spin" />}
          {initial ? 'Save changes' : 'Log print'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

function findFile(files: { id: string; filename: string }[], print: PrintRunView): string {
  return files.find((file) => file.filename === print.filename)?.id ?? ''
}

function numberOrNull(value: string): number | null {
  if (value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * ISO instant to the local-time string `datetime-local` expects.
 *
 * The input has no timezone, so the value must be shifted into local time
 * first — feeding it a raw ISO string silently offsets every print by the
 * viewer's UTC offset.
 */
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

export function formatGrams(grams: number): string {
  return grams >= 1000 ? `${(grams / 1000).toFixed(2)} kg` : `${Math.round(grams)} g`
}
