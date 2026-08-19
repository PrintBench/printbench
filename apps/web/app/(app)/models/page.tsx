import Link from 'next/link'
import { Boxes, ChevronLeft, ChevronRight, HardDrive } from 'lucide-react'
import { sql } from 'drizzle-orm'
import { getDb } from '@pm/db'
import { PageHeader } from '@/components/shell/page-header'
import { EmptyState } from '@/components/ui/empty-state'
import { Button } from '@/components/ui/button'
import { ModelCard } from '@/components/model/model-card'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Models' }

const PAGE_SIZE = 48

type ModelRow = {
  id: string
  public_id: string
  name: string
  path: string
  file_count: number
  total_size: string
  library_name: string
  preview_extension: string | null
}

/**
 * Keyset pagination on (name, id) rather than OFFSET.
 *
 * OFFSET degrades linearly — page 200 of a 10,000-model library makes Postgres
 * walk 9,600 rows it will throw away. A keyset seek is the same cost on page
 * 200 as on page 1, and the partial index on (library_id, name, id) covers it.
 */
export default async function ModelsPage({
  searchParams,
}: {
  searchParams: Promise<{ after?: string; afterId?: string; before?: string }>
}) {
  const params = await searchParams
  const db = getDb()

  const afterName = params.after
  const afterId = params.afterId

  const result = await db.execute<ModelRow>(sql`
    SELECT m.id, m.public_id, m.name, m.path, m.file_count, m.total_size,
           l.name AS library_name,
           f.extension AS preview_extension
    FROM models m
    JOIN libraries l ON l.id = m.library_id
    LEFT JOIN model_files f ON f.id = m.preview_file_id
    WHERE m.missing_at IS NULL
      ${
        afterName && afterId
          ? sql`AND (m.name, m.id) > (${afterName}, ${afterId}::uuid)`
          : sql``
      }
    ORDER BY m.name ASC, m.id ASC
    LIMIT ${PAGE_SIZE + 1}
  `)

  const rows = result.rows.slice(0, PAGE_SIZE)
  const hasMore = result.rows.length > PAGE_SIZE
  const last = rows[rows.length - 1]

  const totals = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM models WHERE missing_at IS NULL`,
  )
  const total = totals.rows[0]?.n ?? 0

  if (total === 0) {
    return (
      <>
        <PageHeader title="Models" />
        <EmptyState
          icon={<HardDrive />}
          title="Nothing indexed yet"
          description="Add a library and run a scan, and your models will appear here."
          action={
            <Button asChild>
              <Link href="/admin/libraries">Go to libraries</Link>
            </Button>
          }
        />
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Models"
        description={`${new Intl.NumberFormat('en-GB').format(total)} in your library`}
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={<Boxes />}
          title="Nothing on this page"
          description="You have reached the end of the list."
          action={
            <Button asChild variant="secondary">
              <Link href="/models">Back to the start</Link>
            </Button>
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {rows.map((row) => (
              <ModelCard
                key={row.id}
                publicId={row.public_id}
                name={row.name}
                path={row.path}
                fileCount={row.file_count}
                totalSize={Number(row.total_size)}
                libraryName={row.library_name}
                previewExtension={row.preview_extension}
              />
            ))}
          </div>

          <nav className="mt-8 flex items-center justify-between" aria-label="Pagination">
            <Button asChild variant="secondary" size="sm" disabled={!afterName}>
              <Link href="/models">
                <ChevronLeft />
                First page
              </Link>
            </Button>

            {hasMore && last && (
              <Button asChild variant="secondary" size="sm">
                <Link
                  href={`/models?after=${encodeURIComponent(last.name)}&afterId=${last.id}`}
                >
                  Next
                  <ChevronRight />
                </Link>
              </Button>
            )}
          </nav>
        </>
      )}
    </>
  )
}
