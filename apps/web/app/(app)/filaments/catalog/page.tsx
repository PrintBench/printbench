import Link from 'next/link'
import { Database, SearchX } from 'lucide-react'
import { getSessionUser } from '@pb/auth'
import { CATALOG_PAGE_SIZE, can, catalogFacets, catalogStatus, searchCatalog } from '@pb/core'
import { getDb } from '@pb/db'
import { NotPermitted } from '@/components/shell/not-permitted'
import { PageHeader } from '@/components/shell/page-header'
import { EmptyState } from '@/components/ui/empty-state'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { CatalogLogo, Swatch } from '@/components/filament/swatch'
import { formatRange } from '@/components/filament/format'
import { FilamentTabs } from '../tabs'
import { CatalogControls } from './catalog-controls'
import { CatalogAttribution } from './attribution'
import { catalogHref, parseCatalogParams } from './params'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Filament catalogue' }

const NUMBER = new Intl.NumberFormat('en-GB')

/**
 * The bundled filament catalogue (Open Filament Database). Read from Postgres
 * only — the data ships with the release and the worker imports it, so this
 * works with no internet connection.
 */
export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await getSessionUser()
  if (!can(user, 'filament:view')) return <NotPermitted what="the filament catalogue" />

  const raw = await searchParams
  const params = parseCatalogParams(raw)
  const db = getDb()
  const status = await catalogStatus(db)

  const header = (
    <>
      <PageHeader
        title="Filaments"
        description="Browse filament from hundreds of brands, with print settings, spool details and where to buy."
      />
      <FilamentTabs active="catalog" />
    </>
  )

  if (!status) {
    return (
      <>
        {header}
        <EmptyState
          icon={<Database />}
          title="The catalogue is being prepared"
          description="The worker loads the filament catalogue shortly after PrintBench starts. Refresh in a minute; if it stays empty, check the worker is running."
        />
      </>
    )
  }

  const [result, facets] = await Promise.all([
    searchCatalog(db, {
      query: params.q,
      brandUuid: params.brand,
      material: params.material,
      diameterMm: params.diameter,
      includeDiscontinued: params.discontinued,
      limit: CATALOG_PAGE_SIZE,
      offset: (params.page - 1) * CATALOG_PAGE_SIZE,
    }),
    catalogFacets(db),
  ])
  const totalPages = Math.max(1, Math.ceil(result.total / CATALOG_PAGE_SIZE))

  return (
    <>
      {header}
      <div className="space-y-5">
        <CatalogControls params={raw} facets={facets} initialQuery={params.q} />
        <p className="text-sm text-[var(--color-ink-muted)]" aria-live="polite">
          {NUMBER.format(result.total)} {result.total === 1 ? 'product' : 'products'}
        </p>

        {result.items.length === 0 ? (
          <EmptyState
            icon={<SearchX />}
            title="No filament matches"
            description="Try fewer words, another brand or material, or include discontinued filament."
          />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {result.items.map((item) => {
              const extra = item.matchedVariants - item.swatches.length
              const nozzle = formatRange(item.minPrintTempC, item.maxPrintTempC, '°C')
              const bed = formatRange(item.minBedTempC, item.maxBedTempC, '°C')
              return (
                <Link
                  key={item.uuid}
                  href={`/filaments/catalog/${item.uuid}`}
                  className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 transition-colors hover:border-[var(--color-accent)]"
                >
                  <div className="flex items-start gap-3">
                    <CatalogLogo
                      path={item.brand.logoPath}
                      name={item.brand.name}
                      className="h-10 w-16 shrink-0"
                    />
                    <div className="min-w-0">
                      <p className="text-xs text-[var(--color-ink-muted)]">{item.brand.name}</p>
                      <h2 className="break-words font-semibold">{item.name}</h2>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <Badge>{item.material}</Badge>
                        {item.discontinued && <Badge tone="danger">Discontinued</Badge>}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {item.swatches.map((s) => (
                      <Swatch
                        key={s.uuid}
                        colorHex={s.colorHex}
                        colorHexes={s.colorHexes}
                        title={s.name}
                        className="size-6"
                      />
                    ))}
                    {extra > 0 && (
                      <span className="text-xs text-[var(--color-ink-muted)]">+{extra}</span>
                    )}
                  </div>
                  <p className="mt-auto text-xs text-[var(--color-ink-muted)]">
                    {[
                      nozzle && `Nozzle ${nozzle}`,
                      bed && `Bed ${bed}`,
                      params.q && item.matchedVariants < item.totalVariants
                        ? `${item.matchedVariants} of ${item.totalVariants} colours`
                        : `${item.totalVariants} ${item.totalVariants === 1 ? 'colour' : 'colours'}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </Link>
              )
            })}
          </div>
        )}

        {totalPages > 1 && (
          <nav className="flex items-center justify-between gap-4" aria-label="Pagination">
            <Button asChild variant="secondary" size="sm" disabled={params.page <= 1}>
              <Link href={catalogHref(raw, { page: String(params.page - 1) })}>Previous</Link>
            </Button>
            <span className="text-sm text-[var(--color-ink-muted)]">
              Page {params.page} of {NUMBER.format(totalPages)}
            </span>
            <Button asChild variant="secondary" size="sm" disabled={params.page >= totalPages}>
              <Link href={catalogHref(raw, { page: String(params.page + 1) })}>Next</Link>
            </Button>
          </nav>
        )}

        <CatalogAttribution status={status} />
      </div>
    </>
  )
}
