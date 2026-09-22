import Link from 'next/link'
import type { Route } from 'next'
import { notFound } from 'next/navigation'
import { can, creatorBySlug, searchModels } from '@pb/core'
import { getSessionUser } from '@pb/auth'
import { getDb } from '@pb/db'
import { PageHeader } from '@/components/shell/page-header'
import { NotPermitted } from '@/components/shell/not-permitted'
import { EmptyState } from '@/components/ui/empty-state'
import { Button } from '@/components/ui/button'
import { CreatorItemSection } from '@/components/creator/creator-item-section'

export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const creator = await creatorBySlug(getDb(), slug)
  return { title: creator?.name ?? 'Creator' }
}

export default async function CreatorPage({ params }: { params: Promise<{ slug: string }> }) {
  const user = await getSessionUser()
  if (!can({ id: user?.id ?? '', role: user?.role ?? null }, 'model:view')) {
    return <NotPermitted what="creators" />
  }

  const { slug } = await params
  const db = getDb()

  const creator = await creatorBySlug(db, slug)
  if (!creator) notFound()

  // Reuse search for both item types so filtering, sorting and the hit shape
  // stay consistent with the rest of the application. Keep the initial
  // batches deliberately small: some creators may have thousands of items.
  const [packages, models] = await Promise.all([
    searchModels(db, {
      creatorIds: [creator.id],
      isPackage: true,
      includeFacets: false,
      limit: 24,
    }),
    searchModels(db, {
      creatorIds: [creator.id],
      isPackage: false,
      includeFacets: false,
      limit: 48,
    }),
  ])

  return (
    <>
      <nav className="mb-4 flex items-center gap-1.5 text-sm text-[var(--color-ink-muted)]">
        <Link href="/creators" className="hover:text-[var(--color-ink)]">
          Creators
        </Link>
        <span aria-hidden>/</span>
        <span className="truncate text-[var(--color-ink)]">{creator.name}</span>
      </nav>

      <PageHeader
        title={creator.name}
        description={creator.notes ?? undefined}
        actions={
          <Button asChild variant="secondary" size="sm">
            <Link href={`/search?creator=${creator.id}` as Route}>Search within</Link>
          </Button>
        }
      />

      {packages.total === 0 && models.total === 0 ? (
        <EmptyState
          title="Nothing here yet"
          description="No models or packages are attributed to this creator, or the ones that were are missing from disk."
        />
      ) : (
        <>
          <p className="mb-6 text-sm text-[var(--color-ink-muted)]">
            {creator.modelCount.toLocaleString()} Model
            {creator.modelCount === 1 ? '' : 's'} · {creator.packageCount.toLocaleString()} Package
            {creator.packageCount === 1 ? '' : 's'}
          </p>

          {packages.total > 0 && (
            <CreatorItemSection
              creatorId={creator.id}
              type="package"
              title="Packages"
              initialItems={packages.hits}
              total={packages.total}
              batchSize={24}
              className="mb-8"
            />
          )}

          {models.total > 0 && (
            <CreatorItemSection
              creatorId={creator.id}
              type="model"
              title="Models"
              initialItems={models.hits}
              total={models.total}
              batchSize={48}
            />
          )}
        </>
      )}
    </>
  )
}
