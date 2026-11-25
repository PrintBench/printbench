import Link from 'next/link'
import type { Route } from 'next'
import { notFound } from 'next/navigation'
import { ArrowLeft, ExternalLink, FileText, Plus } from 'lucide-react'
import { getSessionUser } from '@pb/auth'
import { can, catalogStatus, getCatalogFilament, type CatalogVariantView } from '@pb/core'
import { getDb } from '@pb/db'
import { NotPermitted } from '@/components/shell/not-permitted'
import { PageHeader } from '@/components/shell/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CatalogLogo, Swatch } from '@/components/filament/swatch'
import { formatRange, formatValue, formatWeight, humanise } from '@/components/filament/format'
import { CatalogAttribution } from '../attribution'

export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: { params: Promise<{ uuid: string }> }) {
  const filament = await getCatalogFilament(getDb(), (await params).uuid)
  if (!filament) return { title: 'Filament catalogue' }
  return { title: `${displayName(filament)} · Filament catalogue` }
}

/** Many products are named just "PETG"; the brand makes the heading meaningful. */
function displayName(filament: { name: string; brand: { name: string } }): string {
  return filament.name.toLowerCase().startsWith(filament.brand.name.toLowerCase())
    ? filament.name
    : `${filament.brand.name} ${filament.name}`
}

const ENCLOSURE: Record<string, string> = {
  not_needed: 'Not needed',
  recommended: 'Recommended',
  required: 'Required',
}

/** Links out to community data: never trusted to pass referrer or opener. */
const external = { target: '_blank', rel: 'noopener noreferrer nofollow' } as const

export default async function CatalogFilamentPage({
  params,
}: {
  params: Promise<{ uuid: string }>
}) {
  const user = await getSessionUser()
  if (!can(user, 'filament:view')) return <NotPermitted what="the filament catalogue" />
  const db = getDb()
  const [filament, status] = await Promise.all([
    getCatalogFilament(db, (await params).uuid),
    catalogStatus(db),
  ])
  if (!filament) notFound()
  const canManage = can(user, 'filament:manage')

  const specs: [string, string | null][] = [
    ['Nozzle', formatRange(filament.minPrintTempC, filament.maxPrintTempC, '°C')],
    ['Preheat', formatValue(filament.preheatTempC, '°C')],
    ['Bed', formatRange(filament.minBedTempC, filament.maxBedTempC, '°C')],
    [
      'Chamber',
      formatValue(filament.chamberTempC, '°C') ??
        formatRange(filament.minChamberTempC, filament.maxChamberTempC, '°C'),
    ],
    [
      'Enclosure',
      filament.enclosure ? (ENCLOSURE[filament.enclosure] ?? humanise(filament.enclosure)) : null,
    ],
    [
      'Drying',
      filament.dryTempC != null
        ? [formatValue(filament.dryTempC, '°C'), formatValue(filament.dryTimeH, 'h')]
            .filter(Boolean)
            .join(' for ')
        : null,
    ],
    ['Max drying temp', formatValue(filament.maxDryTempC, '°C')],
    ['Density', formatValue(filament.densityGCm3, 'g/cm³')],
    [
      'Diameter tolerance',
      filament.diameterToleranceMm != null ? `± ${filament.diameterToleranceMm} mm` : null,
    ],
    ['Min nozzle', formatValue(filament.minNozzleMm, 'mm')],
    ['Print speed', formatRange(filament.minPrintSpeedMmS, filament.maxPrintSpeedMmS, 'mm/s')],
    ['Max volumetric speed', formatValue(filament.maxVolumetricSpeedMm3S, 'mm³/s')],
    ['Fan', formatRange(filament.minFanSpeedPct, filament.maxFanSpeedPct, '%')],
    [
      'Shore hardness',
      filament.shoreHardnessA != null
        ? `${filament.shoreHardnessA}A`
        : filament.shoreHardnessD != null
          ? `${filament.shoreHardnessD}D`
          : null,
    ],
  ]
  const shownSpecs = specs.filter((s): s is [string, string] => s[1] !== null)
  const title = displayName(filament)
  const live = filament.variants.filter((v) => !v.removed)
  const removed = filament.variants.filter((v) => v.removed)

  return (
    <>
      <PageHeader
        title={title}
        description={[filament.brand.name, filament.material].join(' · ')}
        actions={
          <Button asChild variant="secondary" size="sm">
            <Link href="/filaments/catalog">
              <ArrowLeft className="size-4" /> Catalogue
            </Link>
          </Button>
        }
      />
      <div className="space-y-8">
        <section className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:flex-row sm:items-start sm:gap-6">
          <CatalogLogo
            path={filament.brand.logoPath}
            name={filament.brand.name}
            className="h-16 w-28"
          />
          <div className="min-w-0 flex-1 space-y-3">
            <div className="flex flex-wrap gap-1">
              <Badge>{filament.material}</Badge>
              {filament.discontinued && <Badge tone="danger">Discontinued</Badge>}
              {filament.removed && <Badge tone="danger">No longer in catalogue</Badge>}
              {filament.certifications.map((c) => (
                <Badge key={c} tone="accent">
                  {c}
                </Badge>
              ))}
            </div>
            {shownSpecs.length > 0 ? (
              <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
                {shownSpecs.map(([label, value]) => (
                  <div
                    key={label}
                    className="flex justify-between gap-3 border-b border-[var(--color-border)] py-1"
                  >
                    <dt className="text-[var(--color-ink-muted)]">{label}</dt>
                    <dd className="text-right font-medium">{value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-sm text-[var(--color-ink-muted)]">
                No print settings recorded for this filament yet.
              </p>
            )}
            <div className="flex flex-wrap gap-3 text-sm">
              {filament.dataSheetUrl && (
                <a
                  href={filament.dataSheetUrl}
                  {...external}
                  className="inline-flex items-center gap-1 text-[var(--color-accent)] hover:underline"
                >
                  <FileText className="size-4" /> Technical data sheet
                </a>
              )}
              {filament.safetySheetUrl && (
                <a
                  href={filament.safetySheetUrl}
                  {...external}
                  className="inline-flex items-center gap-1 text-[var(--color-accent)] hover:underline"
                >
                  <FileText className="size-4" /> Safety data sheet
                </a>
              )}
              {filament.brand.website && (
                <a
                  href={filament.brand.website}
                  {...external}
                  className="inline-flex items-center gap-1 text-[var(--color-accent)] hover:underline"
                >
                  <ExternalLink className="size-4" /> {filament.brand.name} website
                </a>
              )}
            </div>
            {filament.slicerProfiles.length > 0 && (
              <p className="text-sm text-[var(--color-ink-muted)]">
                Slicer profiles:{' '}
                {filament.slicerProfiles
                  .map((p) => `${humanise(p.slicer)} “${p.profile}”`)
                  .join(', ')}
              </p>
            )}
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="font-semibold">
            Colours{' '}
            <span className="font-normal text-[var(--color-ink-muted)]">({live.length})</span>
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            {live.map((variant) => (
              <VariantCard key={variant.uuid} variant={variant} canManage={canManage} />
            ))}
          </div>
          {removed.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-[var(--color-ink-muted)]">
                {removed.length} colour{removed.length === 1 ? '' : 's'} no longer in the catalogue
              </summary>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                {removed.map((variant) => (
                  <VariantCard key={variant.uuid} variant={variant} canManage={false} />
                ))}
              </div>
            </details>
          )}
        </section>

        {status && <CatalogAttribution status={status} />}
      </div>
    </>
  )
}

function VariantCard({ variant, canManage }: { variant: CatalogVariantView; canManage: boolean }) {
  const addHref = (sizeUuid?: string) =>
    `/filaments?add=${variant.uuid}${sizeUuid ? `&size=${sizeUuid}` : ''}` as Route
  const links = variant.sizes.flatMap((s) => s.links.map((l) => ({ ...l, size: s })))
  return (
    <div className="min-w-0 space-y-3 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex flex-wrap items-start gap-3">
        <Swatch
          colorHex={variant.colorHex}
          colorHexes={variant.colorHexes}
          className="mt-0.5 size-9"
        />
        <div className="min-w-0 flex-1">
          <h3 className="break-words font-medium">{variant.name}</h3>
          <div className="mt-1 flex flex-wrap gap-1">
            {variant.discontinued && <Badge tone="danger">Discontinued</Badge>}
            {variant.removed && <Badge tone="danger">No longer in catalogue</Badge>}
            {variant.traits.map((t) => (
              <Badge key={t}>{humanise(t)}</Badge>
            ))}
            {variant.transmissionDistance != null && (
              <Badge title="Transmission distance, for HueForge-style prints">
                TD {variant.transmissionDistance}
              </Badge>
            )}
          </div>
        </div>
        {canManage && (
          <Button asChild size="sm" variant="secondary">
            <Link
              href={addHref(variant.sizes[0]?.uuid)}
              aria-label={`Add a spool of ${variant.name}`}
            >
              <Plus className="size-4" /> Add spool
            </Link>
          </Button>
        )}
      </div>

      {variant.sizes.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-[var(--color-ink-muted)]">
              <tr>
                <th className="py-1 pr-3 font-medium">Spool</th>
                <th className="py-1 pr-3 font-medium">Diameter</th>
                <th className="py-1 pr-3 font-medium">Empty spool</th>
                <th className="py-1 pr-3 font-medium">Article / barcode</th>
                {canManage && (
                  <th className="py-1 font-medium">
                    <span className="sr-only">Add</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {variant.sizes.map((s) => (
                <tr key={s.uuid} className="border-t border-[var(--color-border)]">
                  <td className="py-1 pr-3">
                    {formatWeight(s.filamentWeightG) ?? '?'}
                    {s.spoolRefill && ' refill'}
                    {s.discontinued && ' (discontinued)'}
                  </td>
                  <td className="py-1 pr-3">{formatValue(s.diameterMm, 'mm') ?? '?'}</td>
                  <td className="py-1 pr-3">{formatWeight(s.emptySpoolWeightG) ?? '–'}</td>
                  <td className="py-1 pr-3 font-mono">
                    {[s.articleNumber, s.gtin].filter(Boolean).join(' · ') || '–'}
                  </td>
                  {canManage && (
                    <td className="py-1 text-right">
                      <Link
                        href={addHref(s.uuid)}
                        className="text-[var(--color-accent)] hover:underline"
                      >
                        Add
                      </Link>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {links.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-[var(--color-ink-muted)]">
            Where to buy ({links.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {links.map((l) => (
              <li key={l.url} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <a
                  href={l.url}
                  {...external}
                  className="inline-flex items-center gap-1 text-[var(--color-accent)] hover:underline"
                >
                  {l.store.name} <ExternalLink className="size-3" />
                </a>
                <span className="text-xs text-[var(--color-ink-muted)]">
                  {[
                    formatWeight(l.size.filamentWeightG),
                    formatValue(l.size.diameterMm, 'mm'),
                    l.spoolRefill && 'refill',
                    l.shipsFrom.length > 0 && `ships from ${l.shipsFrom.join(', ')}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                {l.affiliate && (
                  <Badge title="The store may pay a commission on this link">Affiliate</Badge>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
