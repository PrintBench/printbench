'use client'

import { useRef, useState, useTransition } from 'react'
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
import type { GcodeMetadata, PrintStatus } from '@pb/core'
/*
 * Values come from the leaf export, not the package barrel. This is a client
 * component, and importing a runtime value from '@pb/core' pulls fs, pg and the
 * S3 client into the browser bundle with it.
 */
import {
  BED_ADHESIONS,
  BED_ADHESION_LABELS,
  NOZZLE_TYPES,
  NOZZLE_TYPE_LABELS,
  type BedAdhesion,
  type NozzleType,
} from '@pb/core/prints'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Field } from '@/components/ui/field'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/cn'
import {
  editPrint,
  readSlicerSettings,
  recordPrint,
  removePrint,
  type PrintFormInput,
} from './print-actions'

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
  nozzleType: NozzleType | null
  filamentBrand: string | null
  colorName: string | null
  filamentCost: number | null
  infillPercent: number | null
  wallCount: number | null
  supports: boolean | null
  adhesion: BedAdhesion | null
  nozzleTempC: number | null
  bedTempC: number | null
  slicerName: string | null
  slicerVersion: string | null
  slicerProfile: string | null
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
  suggestions: { materials: string[]; printers: string[]; filamentBrands: string[] }
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
              publicId={publicId}
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

  /*
   * Diameter and material read as one thing — "0.4 mm hardened steel nozzle" —
   * because that is how anyone says it out loud, and either half alone is only
   * half an answer about whether an abrasive filament was safe to run.
   */
  const nozzle = [
    print.nozzleMm != null && `${print.nozzleMm} mm`,
    print.nozzleType && NOZZLE_TYPE_LABELS[print.nozzleType].toLowerCase(),
  ]
    .filter(Boolean)
    .join(' ')

  const filament = [print.filamentBrand, print.material].filter(Boolean).join(' ')

  // The headline: what it ran on, and what it cost in time and plastic.
  const settings = [
    print.printerName,
    filament,
    print.layerHeightMm != null && `${print.layerHeightMm} mm layers`,
    nozzle && `${nozzle} nozzle`,
    print.infillPercent != null && `${print.infillPercent}% infill`,
    print.durationMin != null && formatDuration(print.durationMin),
    print.filamentUsedG != null && formatGrams(print.filamentUsedG),
  ].filter(Boolean) as string[]

  /*
   * A second, quieter line rather than a longer first one. These are the details
   * you go looking for when reproducing a print, not the ones you scan a list
   * for, and folding them into the line above buries the outcome.
   */
  const detail = [
    print.wallCount != null && `${print.wallCount} walls`,
    print.supports != null && (print.supports ? 'supports' : 'no supports'),
    print.adhesion && BED_ADHESION_LABELS[print.adhesion].toLowerCase(),
    print.nozzleTempC != null && `${print.nozzleTempC}/${print.bedTempC ?? '—'} °C`,
    print.colorName,
    print.filamentCost != null && `costs ${print.filamentCost.toFixed(2)}`,
    print.slicerProfile,
    [print.slicerName, print.slicerVersion].filter(Boolean).join(' '),
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
        {detail.length > 0 && (
          <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">{detail.join(' · ')}</p>
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
  publicId,
  initial,
  files,
  suggestions,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  publicId: string
  initial: PrintRunView | null
  files: { id: string; filename: string }[]
  suggestions: { materials: string[]; printers: string[]; filamentBrands: string[] }
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

  const [nozzleType, setNozzleType] = useState<NozzleType | ''>(initial?.nozzleType ?? '')
  const [filamentBrand, setFilamentBrand] = useState(initial?.filamentBrand ?? '')
  const [colorName, setColorName] = useState(initial?.colorName ?? '')
  const [cost, setCost] = useState(initial?.filamentCost?.toString() ?? '')
  const [infill, setInfill] = useState(initial?.infillPercent?.toString() ?? '')
  const [walls, setWalls] = useState(initial?.wallCount?.toString() ?? '')
  // Three states, not a checkbox: unknown is not the same answer as "no".
  const [supports, setSupports] = useState<'' | 'yes' | 'no'>(
    initial?.supports == null ? '' : initial.supports ? 'yes' : 'no',
  )
  const [adhesion, setAdhesion] = useState<BedAdhesion | ''>(initial?.adhesion ?? '')
  const [nozzleTemp, setNozzleTemp] = useState(initial?.nozzleTempC?.toString() ?? '')
  const [bedTemp, setBedTemp] = useState(initial?.bedTempC?.toString() ?? '')
  const [slicerName, setSlicerName] = useState(initial?.slicerName ?? '')
  const [slicerVersion, setSlicerVersion] = useState(initial?.slicerVersion ?? '')
  const [slicerProfile, setSlicerProfile] = useState(initial?.slicerProfile ?? '')

  const [reading, setReading] = useState(false)
  const [filledFrom, setFilledFrom] = useState<string | null>(null)

  /*
   * The values the form started with, so autofill can tell a suggestion it
   * pre-populated from something the user actually typed. Printer and material
   * open pre-filled from the most-used past value, and a sliced file naming a
   * different printer should win over that guess — but never over a real edit.
   */
  const opening = useRef({ printerName, material })

  /** Fills a field from the file, unless the user has already answered it. */
  function fill(current: string, opened: string, set: (value: string) => void, value?: unknown) {
    if (value == null || value === '') return
    if (current !== '' && current !== opened) return
    set(String(value))
  }

  function applySettings(parsed: GcodeMetadata) {
    fill(printerName, opening.current.printerName, setPrinterName, parsed.printerName)
    fill(material, opening.current.material, setMaterial, parsed.material)
    fill(colorHex, '', setColorHex, parsed.colorHex)
    fill(layerHeight, '', setLayerHeight, parsed.layerHeightMm)
    fill(nozzle, '', setNozzle, parsed.nozzleMm)
    fill(duration, '', setDuration, parsed.durationMin)
    fill(filament, '', setFilament, parsed.filamentUsedG)
    fill(filamentBrand, '', setFilamentBrand, parsed.filamentBrand)
    fill(cost, '', setCost, parsed.filamentCost)
    fill(infill, '', setInfill, parsed.infillPercent)
    fill(walls, '', setWalls, parsed.wallCount)
    fill(nozzleTemp, '', setNozzleTemp, parsed.nozzleTempC)
    fill(bedTemp, '', setBedTemp, parsed.bedTempC)
    fill(slicerName, '', setSlicerName, parsed.slicerName)
    fill(slicerVersion, '', setSlicerVersion, parsed.slicerVersion)
    fill(slicerProfile, '', setSlicerProfile, parsed.slicerProfile)

    if (nozzleType === '' && parsed.nozzleType) setNozzleType(parsed.nozzleType)
    if (adhesion === '' && parsed.adhesion) setAdhesion(parsed.adhesion)
    if (supports === '' && parsed.supports != null) setSupports(parsed.supports ? 'yes' : 'no')
  }

  /**
   * Picking a sliced file offers to fill the form in from it.
   *
   * Silent when it finds nothing. This is a convenience on the way past — the
   * form works exactly as it did before — so a file with no readable settings
   * should cost a moment, not an error message about something the user was not
   * asking for.
   */
  function chooseFile(id: string) {
    setModelFileId(id)
    setFilledFrom(null)

    const file = files.find((entry) => entry.id === id)
    if (!file || !isGcodeName(file.filename)) return

    setReading(true)
    void readSlicerSettings(publicId, id)
      .then((result) => {
        if (!result.ok) return
        applySettings(result.settings)
        setFilledFrom(result.filename)
      })
      .finally(() => setReading(false))
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    onSubmit({
      modelFileId: modelFileId || null,
      printerName: printerName || null,
      material: material || null,
      colorHex: colorHex || null,
      layerHeightMm: numberOrNull(layerHeight),
      nozzleMm: numberOrNull(nozzle),
      nozzleType: nozzleType || null,
      filamentBrand: filamentBrand || null,
      colorName: colorName || null,
      filamentCost: numberOrNull(cost),
      infillPercent: numberOrNull(infill),
      wallCount: numberOrNull(walls),
      supports: supports === '' ? null : supports === 'yes',
      adhesion: adhesion || null,
      nozzleTempC: numberOrNull(nozzleTemp),
      bedTempC: numberOrNull(bedTemp),
      slicerName: slicerName || null,
      slicerVersion: slicerVersion || null,
      slicerProfile: slicerProfile || null,
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
          <Field
            label="File printed"
            htmlFor="print-file"
            hint={reading ? 'Reading settings…' : 'Fills the settings in, for a .gcode file'}
          >
            <Select value={modelFileId} onChange={(e) => chooseFile(e.target.value)}>
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

        {/* In the main grid rather than behind a section: it is the one setting
            that decides whether an abrasive filament ruins the hot end. */}
        <Field label="Nozzle type" htmlFor="print-nozzle-type">
          <Select
            value={nozzleType}
            onChange={(e) => setNozzleType(e.target.value as NozzleType | '')}
          >
            <option value="">Not recorded</option>
            {NOZZLE_TYPES.map((type) => (
              <option key={type} value={type}>
                {NOZZLE_TYPE_LABELS[type]}
              </option>
            ))}
          </Select>
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

      {filledFrom && (
        <p className="text-xs text-[var(--color-ink-muted)]">
          Filled in from <span className="font-mono">{filledFrom}</span>. Anything you had already
          typed was left alone.
        </p>
      )}

      {/*
       * Native <details>, not a modal or a third-party disclosure. It is
       * keyboard accessible for free, it prints and it survives with JavaScript
       * off — and this file already avoids dialogs on purpose.
       */}
      <details className="rounded-[var(--radius-control)] border border-[var(--color-border)]">
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Filament details</summary>
        <div className="grid gap-3 border-t border-[var(--color-border)] p-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Brand" htmlFor="print-brand">
            <Input
              list="brand-suggestions"
              value={filamentBrand}
              onChange={(e) => setFilamentBrand(e.target.value)}
              placeholder="Prusament"
            />
          </Field>
          <datalist id="brand-suggestions">
            {suggestions.filamentBrands.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>

          <Field label="Colour name" htmlFor="print-colour-name">
            <Input
              value={colorName}
              onChange={(e) => setColorName(e.target.value)}
              placeholder="Galaxy Black"
            />
          </Field>

          <Field label="Cost" htmlFor="print-cost" hint="What this print used, not the spool">
            <Input
              type="number"
              step="0.01"
              min="0"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
            />
          </Field>
        </div>
      </details>

      <details className="rounded-[var(--radius-control)] border border-[var(--color-border)]">
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Slicer settings</summary>
        <div className="grid gap-3 border-t border-[var(--color-border)] p-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Infill (%)" htmlFor="print-infill">
            <Input
              type="number"
              min="0"
              max="100"
              value={infill}
              onChange={(e) => setInfill(e.target.value)}
              placeholder="15"
            />
          </Field>

          <Field label="Walls" htmlFor="print-walls">
            <Input
              type="number"
              min="0"
              max="100"
              value={walls}
              onChange={(e) => setWalls(e.target.value)}
              placeholder="3"
            />
          </Field>

          <Field label="Supports" htmlFor="print-supports">
            <Select
              value={supports}
              onChange={(e) => setSupports(e.target.value as '' | 'yes' | 'no')}
            >
              <option value="">Not recorded</option>
              <option value="yes">Used supports</option>
              <option value="no">No supports</option>
            </Select>
          </Field>

          <Field label="Bed adhesion" htmlFor="print-adhesion">
            <Select
              value={adhesion}
              onChange={(e) => setAdhesion(e.target.value as BedAdhesion | '')}
            >
              <option value="">Not recorded</option>
              {BED_ADHESIONS.map((type) => (
                <option key={type} value={type}>
                  {BED_ADHESION_LABELS[type]}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Nozzle temp (°C)" htmlFor="print-nozzle-temp">
            <Input
              type="number"
              min="0"
              max="500"
              value={nozzleTemp}
              onChange={(e) => setNozzleTemp(e.target.value)}
              placeholder="215"
            />
          </Field>

          <Field label="Bed temp (°C)" htmlFor="print-bed-temp">
            <Input
              type="number"
              min="0"
              max="500"
              value={bedTemp}
              onChange={(e) => setBedTemp(e.target.value)}
              placeholder="60"
            />
          </Field>

          <Field label="Slicer" htmlFor="print-slicer">
            <Input
              value={slicerName}
              onChange={(e) => setSlicerName(e.target.value)}
              placeholder="PrusaSlicer"
            />
          </Field>

          <Field label="Slicer version" htmlFor="print-slicer-version">
            <Input
              value={slicerVersion}
              onChange={(e) => setSlicerVersion(e.target.value)}
              placeholder="2.8.0"
            />
          </Field>

          <Field label="Profile" htmlFor="print-profile" hint="The named preset in the slicer">
            <Input
              value={slicerProfile}
              onChange={(e) => setSlicerProfile(e.target.value)}
              placeholder="0.20mm SPEED @MK4S"
            />
          </Field>
        </div>
      </details>

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

/**
 * Whether picking this file is worth a round-trip.
 *
 * Checked here as well as on the server so choosing an STL does not fire a
 * request that can only come back "not a sliced file". Kept in step with
 * isParsableSlicerFile in the core service, which is the one that decides.
 */
function isGcodeName(filename: string): boolean {
  return /\.(gcode|gco|g|ngc)$/i.test(filename)
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
