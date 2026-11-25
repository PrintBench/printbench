'use client'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { Filament, Spool } from '@pb/core'
import {
  prefillFromCatalog,
  type CatalogPick,
  type FilamentInput,
  type SpoolInput,
} from '@pb/core/filaments'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Field } from '@/components/ui/field'
import { addSpool, saveFilament, saveSpool } from './actions'
import { CatalogPicker } from './catalog-picker'

const DEFAULT_MATERIALS = ['PLA', 'PLA+', 'PETG', 'ABS', 'ASA', 'TPU', 'PA', 'PC']

export function FilamentFields({
  initial,
  materials,
  catalogVariantUuid,
}: {
  initial?: FilamentInput
  /** Material suggestions, from the catalogue when it is loaded. */
  materials?: string[]
  /**
   * Rendered as a hidden field only when given. Forms that leave it out (editing
   * an existing filament) send no value, which keeps the stored link as it is.
   */
  catalogVariantUuid?: string
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {catalogVariantUuid !== undefined && (
        <input type="hidden" name="catalogVariantUuid" value={catalogVariantUuid} />
      )}
      <Field label="Product / display name" htmlFor="filament-name">
        <Input
          id="filament-name"
          name="name"
          required
          defaultValue={initial?.name}
          placeholder="PolyLite PETG"
        />
      </Field>
      <Field label="Material" htmlFor="filament-material">
        <Input
          id="filament-material"
          name="material"
          required
          defaultValue={initial?.material}
          list="filament-materials"
          placeholder="PETG"
        />
      </Field>
      <datalist id="filament-materials">
        {(materials?.length ? materials : DEFAULT_MATERIALS).map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <Field label="Brand" htmlFor="filament-brand">
        <Input
          id="filament-brand"
          name="brand"
          defaultValue={initial?.brand ?? ''}
          placeholder="Polymaker"
        />
      </Field>
      <Field label="Colour name" htmlFor="filament-colour-name">
        <Input
          id="filament-colour-name"
          name="colorName"
          defaultValue={initial?.colorName ?? ''}
          placeholder="Black"
        />
      </Field>
      <Field label="Colour swatch (optional hex)" htmlFor="filament-colour">
        <Input
          id="filament-colour"
          name="colorHex"
          pattern="#[0-9a-fA-F]{6}"
          defaultValue={initial?.colorHex ?? ''}
          placeholder="#222222"
        />
      </Field>
      <Field label="Diameter (mm)" htmlFor="filament-diameter">
        <Input
          id="filament-diameter"
          name="diameterMm"
          type="number"
          min="0.01"
          max="10"
          step="0.01"
          required
          defaultValue={initial?.diameterMm ?? 1.75}
        />
      </Field>
      <Field label="Recommended nozzle (°C)" htmlFor="filament-nozzle">
        <Input
          id="filament-nozzle"
          name="nozzleTempC"
          type="number"
          min="0"
          max="500"
          step="1"
          defaultValue={initial?.nozzleTempC ?? ''}
        />
      </Field>
      <Field label="Recommended bed (°C)" htmlFor="filament-bed">
        <Input
          id="filament-bed"
          name="bedTempC"
          type="number"
          min="0"
          max="500"
          step="1"
          defaultValue={initial?.bedTempC ?? ''}
        />
      </Field>
      <Field label="Filament notes" htmlFor="filament-notes">
        <Input id="filament-notes" name="filamentNotes" defaultValue={initial?.notes ?? ''} />
      </Field>
    </div>
  )
}
export function filamentInput(data: FormData): FilamentInput {
  return {
    name: String(data.get('name') ?? ''),
    material: String(data.get('material') ?? ''),
    brand: String(data.get('brand') ?? ''),
    colorName: String(data.get('colorName') ?? ''),
    colorHex: String(data.get('colorHex') ?? ''),
    diameterMm: Number(data.get('diameterMm')),
    nozzleTempC: nullable(data, 'nozzleTempC'),
    bedTempC: nullable(data, 'bedTempC'),
    notes: String(data.get('filamentNotes') ?? ''),
    catalogVariantUuid: data.has('catalogVariantUuid')
      ? String(data.get('catalogVariantUuid')) || null
      : undefined,
  }
}
function nullable(data: FormData, key: string) {
  const value = data.get(key)
  return value === null || value === '' ? null : Number(value)
}
export function SpoolForm({
  filaments,
  initial,
  duplicate = false,
  materials,
  initialPick = null,
  initialSizeUuid = null,
  onCancel,
}: {
  filaments: Filament[]
  initial?: Spool
  duplicate?: boolean
  materials?: string[]
  initialPick?: CatalogPick | null
  initialSizeUuid?: string | null
  onCancel: () => void
}) {
  const router = useRouter()
  const [filamentId, setFilamentId] = useState(initial?.filamentId ?? '')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [pick, setPick] = useState<CatalogPick | null>(initialPick)
  const [sizeUuid, setSizeUuid] = useState<string | null>(
    initialPick?.sizes.some((s) => s.uuid === initialSizeUuid) ? initialSizeUuid : null,
  )
  const editing = initial && !duplicate
  const prefill = pick ? prefillFromCatalog(pick, sizeUuid) : null
  // Remounting the uncontrolled fields is what applies a new prefill to them.
  const prefillKey = `${pick?.variantUuid ?? 'manual'}:${sizeUuid ?? ''}`
  // Picking a colour you already own offers that filament rather than a duplicate.
  const owned = pick
    ? filaments.find((f) => !f.archived && f.catalogVariantUuid === pick.variantUuid)
    : undefined
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const input: SpoolInput = {
      filamentId: filamentId || undefined,
      filament: filamentId ? undefined : filamentInput(data),
      label: String(data.get('label') ?? ''),
      nominalWeightG: Number(data.get('nominalWeightG')),
      remainingG: Number(data.get('remainingG')),
      emptyWeightG: nullable(data, 'emptyWeightG'),
      purchaseCost: nullable(data, 'purchaseCost'),
      location: String(data.get('location') ?? ''),
      notes: String(data.get('notes') ?? ''),
      lowStockG: Number(data.get('lowStockG')),
      catalogSizeUuid: editing ? undefined : String(data.get('catalogSizeUuid') ?? '') || null,
    }
    setError(null)
    startTransition(async () => {
      const result = editing ? await saveSpool(initial.id, input) : await addSpool(input)
      if (!result.ok) {
        setError(result.error)
        return
      }
      router.refresh()
      onCancel()
    })
  }
  return (
    <form
      onSubmit={submit}
      className="space-y-4 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <h2 className="font-semibold">
        {editing ? 'Edit spool' : duplicate ? 'Duplicate spool' : 'Add spool'}
      </h2>
      {!editing && !filamentId && (
        <CatalogPicker
          pick={pick}
          sizeUuid={sizeUuid}
          onPick={(p) => {
            setPick(p)
            setSizeUuid(p.sizes.length === 1 ? p.sizes[0]!.uuid : null)
          }}
          onSize={setSizeUuid}
          onClear={() => {
            setPick(null)
            setSizeUuid(null)
          }}
        />
      )}
      {!editing && owned && filamentId !== owned.id && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-[var(--color-ink-muted)]">
          You already have “{owned.name}”.
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => setFilamentId(owned.id)}
          >
            Add another spool of it
          </Button>
        </p>
      )}
      {!editing && (
        <Field label="Filament" htmlFor="spool-filament">
          <Select
            id="spool-filament"
            value={filamentId}
            onChange={(e) => setFilamentId(e.target.value)}
          >
            <option value="">Create new filament…</option>
            {filaments
              .filter((f) => !f.archived)
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {[f.brand, f.name, f.colorName].filter(Boolean).join(' · ')}
                </option>
              ))}
          </Select>
        </Field>
      )}
      {!filamentId && (
        <FilamentFields
          key={`filament:${prefillKey}`}
          initial={prefill?.filament}
          materials={materials}
          catalogVariantUuid={pick?.variantUuid ?? ''}
        />
      )}
      {!editing && (
        <input type="hidden" name="catalogSizeUuid" value={prefill?.spool.catalogSizeUuid ?? ''} />
      )}
      <div key={`spool:${prefillKey}`} className="grid gap-3 sm:grid-cols-2">
        <Field label="Spool label" htmlFor="spool-label">
          <Input
            id="spool-label"
            name="label"
            defaultValue={duplicate ? '' : (initial?.label ?? '')}
            placeholder="Roll 2"
          />
        </Field>
        <Field label="Nominal filament weight (g)" htmlFor="spool-nominal">
          <Input
            id="spool-nominal"
            name="nominalWeightG"
            type="number"
            min="0.01"
            step="0.01"
            required
            defaultValue={initial?.nominalWeightG ?? prefill?.spool.nominalWeightG ?? 1000}
          />
        </Field>
        {!editing && (
          <Field
            label="Starting filament remaining (g)"
            htmlFor="spool-remaining"
            hint={
              duplicate
                ? 'Enter the starting weight of this new roll.'
                : 'For a partially used roll, enter what is left.'
            }
          >
            <Input
              id="spool-remaining"
              name="remainingG"
              type="number"
              min="0"
              step="0.01"
              required
              defaultValue={duplicate ? undefined : (prefill?.spool.nominalWeightG ?? 1000)}
            />
          </Field>
        )}
        <Field label="Empty spool weight (g)" htmlFor="spool-empty">
          <Input
            id="spool-empty"
            name="emptyWeightG"
            type="number"
            min="0"
            step="0.01"
            defaultValue={initial?.emptyWeightG ?? prefill?.spool.emptyWeightG ?? ''}
          />
        </Field>
        <Field label="Purchase cost" htmlFor="spool-cost">
          <Input
            id="spool-cost"
            name="purchaseCost"
            type="number"
            min="0"
            step="0.01"
            defaultValue={initial?.purchaseCost ?? ''}
          />
        </Field>
        <Field label="Storage location" htmlFor="spool-location">
          <Input
            id="spool-location"
            name="location"
            defaultValue={initial?.location ?? ''}
            placeholder="Dry box 1"
          />
        </Field>
        <Field label="Low stock threshold (g)" htmlFor="spool-low">
          <Input
            id="spool-low"
            name="lowStockG"
            type="number"
            min="0"
            step="0.01"
            required
            defaultValue={initial?.lowStockG ?? 100}
          />
        </Field>
        <Field label="Spool notes" htmlFor="spool-notes">
          <Input id="spool-notes" name="notes" defaultValue={initial?.notes ?? ''} />
        </Field>
      </div>
      {error && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button disabled={pending}>{pending ? 'Saving…' : 'Save spool'}</Button>
        <Button type="button" variant="secondary" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
export function EditFilamentForm({
  filament,
  onCancel,
}: {
  filament: Filament
  onCancel: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  return (
    <form
      className="space-y-4 rounded-[var(--radius-card)] border border-[var(--color-border)] p-4"
      onSubmit={(e) => {
        e.preventDefault()
        const data = new FormData(e.currentTarget)
        startTransition(async () => {
          const result = await saveFilament(filament.id, filamentInput(data))
          if (!result.ok) {
            setError(result.error)
            return
          }
          router.refresh()
          onCancel()
        })
      }}
    >
      <h2 className="font-semibold">Edit filament details</h2>
      <p className="text-sm text-[var(--color-ink-muted)]">
        These details apply to every spool of this filament. Historical print details stay as
        recorded.
      </p>
      <FilamentFields initial={filament} />
      {error && <p role="alert">{error}</p>}
      <div className="flex gap-2">
        <Button disabled={pending}>Save filament</Button>
        <Button variant="secondary" type="button" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
