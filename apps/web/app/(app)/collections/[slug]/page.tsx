import Link from 'next/link'
import type { Route } from 'next'
import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { can, collectionBySlug, listCollections } from '@pm/core'
import { getSessionUser } from '@pm/auth'
import { getDb } from '@pm/db'
import { PageHeader } from '@/components/shell/page-header'
import { NotPermitted } from '@/components/shell/not-permitted'
import { EmptyState } from '@/components/ui/empty-state'
import { ModelCard, formatDimensions } from '@/components/model/model-card'

export const dynamic = 'force-dynamic'

type Row = {
  public_id: string
  name: string
  path: string
  file_count: number
  total_size: string
  library_name: string
  thumb_file_id: string | null
  bbox_x: string | null
  bbox_y: string | null
  bbox_z: string | null
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const collection = await collectionBySlug(getDb(), slug)
  return { title: collection?.name ?? 'Collection' }
}

export default async function CollectionPage({ params }: { params: Promise<{ slug: string }> }) {
  const user = await getSessionUser()
  if (!can({ id: user?.id ?? '', role: user?.role ?? null }, 'model:view')) {
    return <NotPermitted what="collections" />
  }

  const { slug } = await params
  const db = getDb()

  const collection = await collectionBySlug(db, slug)
  if (!collection) notFound()

  /*
   * Not searchModels: search has no collection filter, and adding one for a
   * page that never needs ranking or facets would be more surface than it is
   * worth. The position column is the collection's own ordering.
   */
  const models = await db.execute<Row>(sql`
    SELECT m.public_id, m.name, m.path, m.file_count, m.total_size,
           l.name AS library_name,
           f.id AS thumb_file_id, f.bbox_x, f.bbox_y, f.bbox_z
    FROM collection_models cm
    JOIN models m ON m.id = cm.model_id
    JOIN libraries l ON l.id = m.library_id
    LEFT JOIN LATERAL (
      SELECT id, bbox_x, bbox_y, bbox_z FROM model_files
      WHERE model_id = m.id AND thumb_state = 'ok' AND missing_at IS NULL
      ORDER BY size DESC LIMIT 1
    ) f ON true
    WHERE cm.collection_id = ${collection.id} AND m.missing_at IS NULL
    ORDER BY cm.position, m.name`)

  const all = await listCollections(db)
  const children = all.filter((c) => c.parentId === collection.id)
  const parent = collection.parentId ? all.find((c) => c.id === collection.parentId) : undefined

  return (
    <>
      <nav className="mb-4 flex items-center gap-1.5 text-sm text-[var(--color-ink-muted)]">
        <Link href="/collections" className="hover:text-[var(--color-ink)]">
          Collections
        </Link>
        {parent && (
          <>
            <span aria-hidden>/</span>
            <Link href={`/collections/${parent.slug}` as Route} className="hover:text-[var(--color-ink)]">
              {parent.name}
            </Link>
          </>
        )}
        <span aria-hidden>/</span>
        <span className="truncate text-[var(--color-ink)]">{collection.name}</span>
      </nav>

      <PageHeader title={collection.name} description={collection.caption ?? undefined} />

      {children.length > 0 && (
        <div className="mb-6">
          <h2 className="mb-2 text-sm font-semibold">Inside this collection</h2>
          <div className="flex flex-wrap gap-2">
            {children.map((child) => (
              <Link
                key={child.id}
                href={`/collections/${child.slug}` as Route}
                className="rounded-full border border-[var(--color-border)] px-3 py-1 text-sm hover:bg-[var(--color-surface-2)]"
              >
                {child.name}
                <span className="ml-1.5 text-xs text-[var(--color-ink-faint)]">
                  {child.modelCount}
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {models.rows.length === 0 ? (
        <EmptyState
          title="Nothing in here yet"
          description="Open a model and add it to this collection from its page."
        />
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
          {models.rows.map((model) => (
            <ModelCard
              key={model.public_id}
              publicId={model.public_id}
              name={model.name}
              path={model.path}
              fileCount={model.file_count}
              totalSize={Number(model.total_size)}
              libraryName={model.library_name}
              thumbFileId={model.thumb_file_id}
              dimensions={formatDimensions(
                Number(model.bbox_x ?? 0),
                Number(model.bbox_y ?? 0),
                Number(model.bbox_z ?? 0),
              )}
            />
          ))}
        </div>
      )}
    </>
  )
}
