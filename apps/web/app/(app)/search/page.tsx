import Link from 'next/link'
import { Search as SearchIcon, SlidersHorizontal } from 'lucide-react'
import { searchModels, type SortOrder } from '@pb/core'
import { getDb } from '@pb/db'
import { PageHeader } from '@/components/shell/page-header'
import { EmptyState } from '@/components/ui/empty-state'
import { Button } from '@/components/ui/button'
import { ModelCard, formatDimensions } from '@/components/model/model-card'
import { SearchBox } from './search-box'
import { FacetPanel } from './facet-panel'
import { parseSearchParams, buildHref } from './params'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Search' }

const NUMBER = new Intl.NumberFormat('en-GB')
const PAGE_SIZE = 48

/**
 * Search page.
 *
 * Every part of the query lives in the URL, so a search can be bookmarked,
 * shared and navigated back to. That also means results are rendered on the
 * server: the first paint already has them, rather than showing a spinner
 * while the browser fetches.
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const raw = await searchParams
  const params = parseSearchParams(raw)
  const page = Math.max(1, params.page)

  const result = await searchModels(getDb(), {
    query: params.q,
    libraryIds: params.library,
    creatorIds: params.creator,
    tagIds: params.tag,
    licenses: params.license,
    extensions: params.format,
    presupported: params.presupported,
    neverPrinted: params.neverPrinted,
    missingPreview: params.missingPreview,
    minSize: params.minSize,
    sort: params.sort as SortOrder,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  })

  const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE))
  const hasFilters =
    params.library.length > 0 ||
    params.creator.length > 0 ||
    params.tag.length > 0 ||
    params.license.length > 0 ||
    params.format.length > 0 ||
    params.presupported ||
    params.neverPrinted ||
    params.missingPreview ||
    params.minSize !== undefined

  return (
    <>
      <PageHeader
        title="Search"
        description={
          params.q || hasFilters
            ? `${NUMBER.format(result.total)} ${result.total === 1 ? 'model' : 'models'}`
            : 'Find anything in your library.'
        }
      />

      <SearchBox initialQuery={params.q} params={raw} />

      <div className="mt-6 grid gap-6 lg:grid-cols-[220px_1fr]">
        <FacetPanel facets={result.facets} params={params} raw={raw} />

        <div className="min-w-0">
          {result.hits.length === 0 ? (
            <EmptyState
              icon={params.q ? <SearchIcon /> : <SlidersHorizontal />}
              title={params.q ? `Nothing matches "${params.q}"` : 'No models match these filters'}
              description={
                params.q
                  ? 'Try fewer words, or check the spelling. Search tolerates small typos, and you can exclude a term with a minus, like: dragon -blue'
                  : 'Loosen or clear the filters to see more.'
              }
              action={
                (params.q || hasFilters) && (
                  <Button asChild variant="secondary">
                    <Link href="/search">Clear everything</Link>
                  </Button>
                )
              }
            />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
                {result.hits.map((hit) => (
                  <ModelCard
                    key={hit.id}
                    publicId={hit.publicId}
                    name={hit.name}
                    path={hit.path}
                    fileCount={hit.fileCount}
                    totalSize={hit.totalSize}
                    libraryName={hit.libraryName}
                    previewExtension={hit.previewExtension}
                    thumbFileId={hit.thumbFileId}
                    dimensions={formatDimensions(
                      hit.bboxX ?? 0,
                      hit.bboxY ?? 0,
                      hit.bboxZ ?? 0,
                    )}
                  />
                ))}
              </div>

              {totalPages > 1 && (
                <nav
                  className="mt-8 flex items-center justify-between gap-4"
                  aria-label="Pagination"
                >
                  <Button asChild variant="secondary" size="sm" disabled={page <= 1}>
                    <Link href={buildHref(raw, { page: String(page - 1) })}>Previous</Link>
                  </Button>
                  <span className="text-sm text-[var(--color-ink-muted)]">
                    Page {page} of {NUMBER.format(totalPages)}
                  </span>
                  <Button asChild variant="secondary" size="sm" disabled={page >= totalPages}>
                    <Link href={buildHref(raw, { page: String(page + 1) })}>Next</Link>
                  </Button>
                </nav>
              )}
            </>
          )}
        </div>
      </div>
    </>
  )
}
