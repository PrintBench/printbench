import Link from 'next/link'
import type { Route } from 'next'
import { History } from 'lucide-react'
import { listPrints, printStats, type PrintStatus } from '@pb/core'
import { getDb } from '@pb/db'
import { getSessionUser } from '@pb/auth'
import { can } from '@pb/core'
import { PageHeader } from '@/components/shell/page-header'
import { NotPermitted } from '@/components/shell/not-permitted'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Button } from '@/components/ui/button'
import { PrintTimeline } from './print-timeline'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Print history' }

const PAGE_SIZE = 50

const FILTERS: { key: string; label: string; status?: PrintStatus[] }[] = [
  { key: 'all', label: 'Everything' },
  { key: 'success', label: 'Successes', status: ['success'] },
  { key: 'failed', label: 'Failures', status: ['failed', 'partial'] },
  { key: 'running', label: 'Still printing', status: ['in_progress'] },
]

export default async function PrintsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; page?: string }>
}) {
  const user = await getSessionUser()
  if (!can({ id: user?.id ?? '', role: user?.role ?? null }, 'model:view')) {
    return <NotPermitted what="print history" />
  }

  const params = await searchParams
  const filter = FILTERS.find((option) => option.key === params.filter) ?? FILTERS[0]!
  const page = Math.max(Number(params.page ?? 1) || 1, 1)

  const db = getDb()
  const [prints, stats] = await Promise.all([
    listPrints(db, {
      status: filter.status,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    printStats(db),
  ])

  const hasMore = prints.length === PAGE_SIZE
  const link = (target: number): Route => `/prints?filter=${filter.key}&page=${target}` as Route

  return (
    <>
      <PageHeader
        title="Print history"
        description={
          stats.total === 0
            ? 'Every print you log appears here.'
            : summarise(
                stats.total,
                stats.successRate,
                stats.totalFilamentG,
                stats.totalDurationMin,
              )
        }
      />

      <nav className="mb-4 flex flex-wrap gap-1.5">
        {FILTERS.map((option) => (
          <Link
            key={option.key}
            href={`/prints?filter=${option.key}` as Route}
            aria-current={option.key === filter.key ? 'page' : undefined}
            className={
              option.key === filter.key
                ? 'rounded-full bg-[var(--color-accent-soft)] px-3 py-1 text-sm font-medium text-[var(--color-accent)]'
                : 'rounded-full px-3 py-1 text-sm text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-2)]'
            }
          >
            {option.label}
          </Link>
        ))}
      </nav>

      {prints.length === 0 ? (
        /*
         * Three different empty states, because they mean different things:
         * nothing logged at all, nothing matching this filter, and a page
         * number past the end. Saying "no prints logged yet" while the header
         * counts one is just wrong.
         */
        <EmptyState
          icon={<History className="size-6" />}
          title={
            page > 1
              ? 'Nothing on this page'
              : stats.total === 0
                ? 'No prints logged yet'
                : `No ${filter.label.toLowerCase()} to show`
          }
          description={
            page > 1
              ? 'Go back a page.'
              : stats.total === 0
                ? 'Open a model and log a print once it comes off the plate. Settings that worked are worth keeping.'
                : 'Nothing in the history matches this filter.'
          }
          action={
            <Button asChild variant="secondary">
              <Link
                href={
                  page > 1 ? link(page - 1) : stats.total === 0 ? '/models' : ('/prints' as Route)
                }
              >
                {page > 1
                  ? 'Previous page'
                  : stats.total === 0
                    ? 'Browse models'
                    : 'Show everything'}
              </Link>
            </Button>
          }
        />
      ) : (
        <Card className="overflow-hidden">
          <PrintTimeline
            prints={prints.map((print) => ({
              id: print.id,
              modelName: print.modelName,
              modelPublicId: print.modelPublicId,
              filename: print.filename,
              userName: print.userName,
              printerName: print.printerName,
              material: print.material,
              colorHex: print.colorHex,
              layerHeightMm: print.layerHeightMm,
              nozzleMm: print.nozzleMm,
              status: print.status,
              durationMin: print.durationMin,
              filamentUsedG: print.filamentUsedG,
              rating: print.rating,
              notes: print.notes,
              at: (print.startedAt ?? print.createdAt).toISOString(),
            }))}
          />
        </Card>
      )}

      {(page > 1 || hasMore) && (
        <div className="mt-4 flex items-center justify-between">
          {page > 1 ? (
            <Button asChild variant="secondary" size="sm">
              <Link href={link(page - 1)}>Newer</Link>
            </Button>
          ) : (
            <span />
          )}
          {hasMore && (
            <Button asChild variant="secondary" size="sm">
              <Link href={link(page + 1)}>Older</Link>
            </Button>
          )}
        </div>
      )}
    </>
  )
}

function summarise(
  total: number,
  successRate: number | null,
  filamentG: number,
  durationMin: number,
): string {
  const parts = [`${total} print${total === 1 ? '' : 's'} logged`]
  // Null, not zero: nothing has settled yet, so there is no rate to quote.
  if (successRate != null) parts.push(`${Math.round(successRate * 100)}% success`)
  if (filamentG > 0) {
    parts.push(
      filamentG >= 1000
        ? `${(filamentG / 1000).toFixed(2)} kg filament`
        : `${Math.round(filamentG)} g filament`,
    )
  }
  if (durationMin > 0) parts.push(`${Math.round(durationMin / 60)} hours on the plate`)
  return parts.join(' · ')
}
