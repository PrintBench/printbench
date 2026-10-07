'use client'
import Link from 'next/link'
import { useState } from 'react'
import type { Filament, Spool } from '@pb/core'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { SpoolForm } from './spool-form'
export function StockIndicator({ spool }: { spool: Spool }) {
  const percent = Math.max(0, Math.min(100, (spool.remainingG / spool.nominalWeightG) * 100))
  const label =
    spool.remainingG < 0
      ? 'Needs correction'
      : spool.remainingG === 0
        ? 'Empty'
        : spool.remainingG <= spool.lowStockG
          ? 'Low stock'
          : 'In stock'
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-medium">{spool.remainingG.toLocaleString()} g remaining</span>
        <span
          className={
            spool.remainingG < 0
              ? 'text-[var(--color-danger)]'
              : spool.remainingG <= spool.lowStockG
                ? 'text-[var(--color-warning)]'
                : 'text-[var(--color-ink-muted)]'
          }
        >
          {spool.archived ? 'Archived · ' : ''}
          {label}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="Filament remaining"
        aria-valuemin={0}
        aria-valuemax={spool.nominalWeightG}
        aria-valuenow={Math.max(0, Math.min(spool.remainingG, spool.nominalWeightG))}
        aria-valuetext={`${spool.remainingG} grams remaining`}
        className="h-2 overflow-hidden rounded-full bg-[var(--color-surface-2)]"
      >
        <div
          className="h-full rounded-full bg-[var(--color-accent)]"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}
export function FilamentLibrary({
  spools,
  filaments,
  canManage,
}: {
  spools: Spool[]
  filaments: Filament[]
  canManage: boolean
}) {
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')
  const [material, setMaterial] = useState('')
  const [location, setLocation] = useState('')
  const [state, setState] = useState('active')
  const materials = [...new Set(spools.map((s) => s.filament.material))].sort()
  const locations = [...new Set(spools.map((s) => s.location).filter(Boolean))].sort()
  const matches = spools.filter((s) => {
    const haystack = [
      s.filament.brand,
      s.filament.name,
      s.filament.material,
      s.filament.colorName,
      s.label,
    ]
      .join(' ')
      .toLowerCase()
    return (
      haystack.includes(query.toLowerCase()) &&
      (!material || s.filament.material === material) &&
      (!location || s.location === location) &&
      (state === 'archived' ? s.archived : !s.archived) &&
      (state !== 'low' || s.remainingG <= s.lowStockG) &&
      (state !== 'empty' || s.remainingG <= 0)
    )
  })
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[var(--color-ink-muted)]">
          {spools.filter((s) => !s.archived).length} active spools
        </p>
        {canManage && (
          <Button onClick={() => setAdding(!adding)}>{adding ? 'Close form' : 'Add spool'}</Button>
        )}
      </div>
      {adding && <SpoolForm filaments={filaments} onCancel={() => setAdding(false)} />}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Input
          aria-label="Search filaments"
          placeholder="Search brand, material, colour…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Select
          aria-label="Filter material"
          value={material}
          onChange={(e) => setMaterial(e.target.value)}
        >
          <option value="">All materials</option>
          {materials.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </Select>
        <Select
          aria-label="Filter location"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        >
          <option value="">All locations</option>
          {locations.map((l) => (
            <option key={l} value={l!}>
              {l}
            </option>
          ))}
        </Select>
        <Select aria-label="Filter stock" value={state} onChange={(e) => setState(e.target.value)}>
          <option value="active">Active spools</option>
          <option value="low">Low stock</option>
          <option value="empty">Empty / needs correction</option>
          <option value="archived">Archived</option>
        </Select>
      </div>
      {matches.length === 0 ? (
        <div className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-border)] p-10 text-center">
          <h2 className="font-semibold">
            {spools.length ? 'No matching spools' : 'Start your filament library'}
          </h2>
          <p className="mt-2 text-sm text-[var(--color-ink-muted)]">
            {spools.length
              ? 'Try a different search or filter.'
              : 'Add a roll to track its remaining weight and use it in your print logs.'}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {matches.map((s) => (
            <Link
              key={s.id}
              href={`/filaments/${s.id}`}
              className="space-y-4 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 transition-colors hover:border-[var(--color-accent)]"
            >
              <div className="flex items-start gap-3">
                <span
                  aria-hidden
                  className="mt-1 size-9 shrink-0 rounded-full border border-[var(--color-border)]"
                  style={{ background: s.filament.colorHex ?? 'var(--color-surface-2)' }}
                />
                <div className="min-w-0">
                  <h2 className="break-words font-semibold">{s.label || s.filament.name}</h2>
                  <p className="text-sm text-[var(--color-ink-muted)]">
                    {[s.filament.brand, s.filament.name, s.filament.material, s.filament.colorName]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
              </div>
              <StockIndicator spool={s} />
              <p className="text-xs text-[var(--color-ink-muted)]">
                {s.location || 'No location set'} · {s.filament.diameterMm} mm · {s.nominalWeightG}{' '}
                g roll
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
