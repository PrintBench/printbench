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
import { ModelGrid } from '@/components/model/model-grid'

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

  // Reuses search rather than a second query: the filters, sorting and hit
  // shape are already there, and one of them drifting is one bug too many.
  const result = await searchModels(db, { creatorIds: [creator.id], limit: 96 })

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

      {result.hits.length === 0 ? (
        <EmptyState
          title="Nothing here yet"
          description="No models are attributed to this creator, or the ones that were are missing from disk."
        />
      ) : (
        <>
          <p className="mb-3 text-sm text-[var(--color-ink-muted)]">
            {creator.modelCount} model{creator.modelCount === 1 ? '' : 's'}
          </p>
          <ModelGrid models={result.hits} />
          {result.total > result.hits.length && (
            <p className="mt-4 text-sm text-[var(--color-ink-muted)]">
              Showing {result.hits.length} of {result.total}.{' '}
              <Link
                href={`/search?creator=${creator.id}` as Route}
                className="text-[var(--color-accent)] hover:underline"
              >
                See them all in search
              </Link>
            </p>
          )}
        </>
      )}
    </>
  )
}
