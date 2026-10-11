'use client'
import Link from 'next/link'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { Filament, Spool, spoolHistory, spoolPrints } from '@pb/core'
import { remainingFromMeasurement } from '@pb/core/filaments'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Field } from '@/components/ui/field'
import { StockIndicator } from './library'
import { EditFilamentForm, SpoolForm } from './spool-form'
import { correctSpool, setFilamentArchived, setSpoolArchived } from './actions'
type History = Awaited<ReturnType<typeof spoolHistory>>
export function SpoolDetails({
  spool,
  filaments,
  history,
  prints,
  canManage,
}: {
  spool: Spool
  filaments: Filament[]
  history: History
  prints: Awaited<ReturnType<typeof spoolPrints>>
  canManage: boolean
}) {
  const router = useRouter()
  const [mode, setMode] = useState<'edit' | 'duplicate' | 'filament' | null>(null)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [weighing, setWeighing] = useState(false)
  const [whole, setWhole] = useState('')
  const [empty, setEmpty] = useState(spool.emptyWeightG?.toString() ?? '')
  const [remaining, setRemaining] = useState('')
  let measured: number | null = null
  try {
    if (whole !== '' && empty !== '')
      measured = remainingFromMeasurement(Number(whole), Number(empty))
  } catch {
    /* Shown as an invalid measurement below. */
  }
  function run(action: () => ReturnType<typeof setSpoolArchived>) {
    setError(null)
    startTransition(async () => {
      const result = await action()
      if (!result.ok) setError(result.error)
      else router.refresh()
    })
  }
  return (
    <div className="space-y-5">
      <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <StockIndicator spool={spool} />
        <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-[var(--color-ink-muted)]">Location</dt>
            <dd>{spool.location || 'Not set'}</dd>
          </div>
          <div>
            <dt className="text-[var(--color-ink-muted)]">Purchase cost</dt>
            <dd>{spool.purchaseCost?.toFixed(2) ?? 'Unknown'}</dd>
          </div>
          <div>
            <dt className="text-[var(--color-ink-muted)]">Diameter</dt>
            <dd>{spool.filament.diameterMm} mm</dd>
          </div>
          <div>
            <dt className="text-[var(--color-ink-muted)]">Nozzle / bed</dt>
            <dd>
              {spool.filament.nozzleTempC ?? '—'} / {spool.filament.bedTempC ?? '—'} °C
            </dd>
          </div>
          <div>
            <dt className="text-[var(--color-ink-muted)]">Empty spool</dt>
            <dd>{spool.emptyWeightG == null ? 'Unknown' : `${spool.emptyWeightG} g`}</dd>
          </div>
          <div>
            <dt className="text-[var(--color-ink-muted)]">Low stock at</dt>
            <dd>{spool.lowStockG} g</dd>
          </div>
        </dl>
        {[spool.filament.notes, spool.notes].filter(Boolean).map((note, i) => (
          <p key={i} className="mt-3 whitespace-pre-wrap text-sm">
            {note}
          </p>
        ))}
      </div>
      {canManage && (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setMode('edit')}>
            Edit spool
          </Button>
          <Button
            variant="secondary"
            disabled={spool.filament.archived}
            onClick={() => setMode('duplicate')}
          >
            Duplicate spool
          </Button>
          <Button variant="secondary" onClick={() => setMode('filament')}>
            Edit filament details
          </Button>
          <Button
            variant="secondary"
            disabled={pending || spool.filament.archived}
            onClick={() => run(() => setSpoolArchived(spool.id, !spool.spoolArchived))}
          >
            {spool.spoolArchived ? 'Restore spool' : 'Archive spool'}
          </Button>
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() =>
              run(() => setFilamentArchived(spool.filamentId, !spool.filament.archived))
            }
          >
            {spool.filament.archived ? 'Restore filament' : 'Archive filament and all its spools'}
          </Button>
        </div>
      )}
      {mode === 'filament' && (
        <EditFilamentForm filament={spool.filament} onCancel={() => setMode(null)} />
      )}
      {(mode === 'edit' || mode === 'duplicate') && (
        <SpoolForm
          key={mode}
          initial={spool}
          duplicate={mode === 'duplicate'}
          filaments={filaments}
          onCancel={() => setMode(null)}
        />
      )}
      {canManage && (
        <form
          className="space-y-4 rounded-[var(--radius-card)] border border-[var(--color-border)] p-4"
          onSubmit={(e) => {
            e.preventDefault()
            const data = new FormData(e.currentTarget)
            run(() =>
              correctSpool(spool.id, {
                ...(weighing
                  ? { wholeG: Number(whole), emptyG: Number(empty) }
                  : { remainingG: Number(remaining) }),
                reason: String(data.get('reason') ?? ''),
              }),
            )
          }}
        >
          <h2 className="font-semibold">Update remaining weight</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Method" htmlFor="weight-method">
              <Select
                id="weight-method"
                value={weighing ? 'weigh' : 'direct'}
                onChange={(e) => setWeighing(e.target.value === 'weigh')}
              >
                <option value="direct">Enter filament remaining</option>
                <option value="weigh">Weigh the whole spool</option>
              </Select>
            </Field>
            {weighing ? (
              <>
                <Field label="Whole spool weight (g)" htmlFor="whole-weight">
                  <Input
                    id="whole-weight"
                    type="number"
                    min="0"
                    step="0.01"
                    required
                    value={whole}
                    onChange={(e) => setWhole(e.target.value)}
                  />
                </Field>
                <Field label="Empty spool weight (g)" htmlFor="empty-weight">
                  <Input
                    id="empty-weight"
                    type="number"
                    min="0"
                    step="0.01"
                    required
                    value={empty}
                    onChange={(e) => setEmpty(e.target.value)}
                  />
                </Field>
                <p className="self-center text-sm">
                  {measured == null
                    ? 'Enter weights with the whole spool heavier than its empty weight.'
                    : `${measured} g filament remaining`}
                </p>
              </>
            ) : (
              <Field label="Filament remaining (g)" htmlFor="remaining-weight">
                <Input
                  id="remaining-weight"
                  type="number"
                  min="0"
                  step="0.01"
                  required
                  value={remaining}
                  onChange={(e) => setRemaining(e.target.value)}
                />
              </Field>
            )}
            <Field label="Reason" htmlFor="weight-reason">
              <Input
                id="weight-reason"
                name="reason"
                required
                placeholder="Weighed after printing outside Print Bench"
              />
            </Field>
          </div>
          <Button disabled={pending || (weighing && measured == null)}>
            Save weight correction
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}
      <section>
        <h2 className="mb-3 font-semibold">Prints using this spool</h2>
        {prints.length ? (
          <ul className="divide-y divide-[var(--color-border)] rounded-[var(--radius-card)] border border-[var(--color-border)]">
            {prints.map((print) => (
              <li
                key={print.id}
                className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm"
              >
                <Link
                  href={`/models/${print.model_public_id}`}
                  className="text-[var(--color-accent)] hover:underline"
                >
                  {print.model_name}
                </Link>
                <span>
                  {print.grams} g ·{' '}
                  {print.status === 'in_progress' ? 'Still printing (estimate)' : print.status}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-[var(--color-ink-muted)]">
            No prints recorded for this spool.
          </p>
        )}
      </section>
      <section>
        <h2 className="mb-3 font-semibold">Stock history</h2>
        <ol className="divide-y divide-[var(--color-border)] rounded-[var(--radius-card)] border border-[var(--color-border)]">
          {history.map((change) => (
            <li
              key={change.id}
              className="flex flex-wrap items-start justify-between gap-3 p-4 text-sm"
            >
              <div>
                <p className="font-medium">{change.reason}</p>
                {change.model_public_id && (
                  <Link
                    href={`/models/${change.model_public_id}`}
                    className="text-[var(--color-accent)] hover:underline"
                  >
                    {change.model_name}
                  </Link>
                )}
                <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
                  {new Date(change.created_at).toLocaleString('en-GB', {
                    timeZone: 'Europe/London',
                  })}
                  {change.actor_name ? ` · ${change.actor_name}` : ''}
                </p>
              </div>
              <span className="font-medium tabular-nums">
                {change.amount_g > 0 ? '+' : ''}
                {change.amount_g} g
              </span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}
