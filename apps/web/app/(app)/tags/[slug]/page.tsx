import Link from 'next/link'
import type { Route } from 'next'
import { notFound } from 'next/navigation'
import { can, searchModels, tagBySlug } from '@pm/core'
import { getSessionUser } from '@pm/auth'
import { getDb } from '@pm/db'
import { PageHeader } from '@/components/shell/page-header'
import { NotPermitted } from '@/components/shell/not-permitted'
import { EmptyState } from '@/components/ui/empty-state'
import { Button } from '@/components/ui/button'
import { ModelGrid } from '@/components/model/model-grid'

export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const tag = await tagBySlug(getDb(), slug)
  return { title: tag ? `#${tag.name}` : 'Tag' }
}

export default async function TagPage({ params }: { params: Promise<{ slug: string }> }) {
  const user = await getSessionUser()
  if (!can({ id: user?.id ?? '', role: user?.role ?? null }, 'model:view')) {
    return <NotPermitted what="tags" />
  }

  const { slug } = await params
  const db = getDb()

  const tag = await tagBySlug(db, slug)
  if (!tag) notFound()

  const result = await searchModels(db, { tagIds: [tag.id], limit: 96 })

  return (
    <>
      <nav className="mb-4 flex items-center gap-1.5 text-sm text-[var(--color-ink-muted)]">
        <Link href="/tags" className="hover:text-[var(--color-ink)]">
          Tags
        </Link>
        <span aria-hidden>/</span>
        <span className="flex items-center gap-1.5 truncate text-[var(--color-ink)]">
          {tag.color && (
            <span
              className="size-2.5 rounded-full"
              style={{ backgroundColor: tag.color }}
              aria-hidden
            />
          )}
          {tag.name}
        </span>
      </nav>

      <PageHeader
        title={tag.name}
        description={`${tag.modelCount} model${tag.modelCount === 1 ? '' : 's'}`}
        actions={
          <Button asChild variant="secondary" size="sm">
            <Link href={`/search?tag=${tag.id}` as Route}>Search within</Link>
          </Button>
        }
      />

      {result.hits.length === 0 ? (
        <EmptyState
          title="Nothing tagged with this"
          description="Every model that had this tag is missing from disk, or the tag is no longer used."
        />
      ) : (
        <>
          <ModelGrid models={result.hits} />
          {result.total > result.hits.length && (
            <p className="mt-4 text-sm text-[var(--color-ink-muted)]">
              Showing {result.hits.length} of {result.total}.{' '}
              <Link
                href={`/search?tag=${tag.id}` as Route}
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
