import Link from 'next/link'
import type { Route } from 'next'
import { Users } from 'lucide-react'
import { can, listCreators } from '@pb/core'
import { getSessionUser } from '@pb/auth'
import { getDb } from '@pb/db'
import { PageHeader } from '@/components/shell/page-header'
import { NotPermitted } from '@/components/shell/not-permitted'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Button } from '@/components/ui/button'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Creators' }

export default async function CreatorsPage() {
  const user = await getSessionUser()
  if (!can({ id: user?.id ?? '', role: user?.role ?? null }, 'model:view')) {
    return <NotPermitted what="creators" />
  }

  const creators = await listCreators(getDb())
  const withModels = creators.filter((creator) => creator.modelCount > 0)
  const empty = creators.filter((creator) => creator.modelCount === 0)

  return (
    <>
      <PageHeader
        title="Creators"
        description={
          creators.length === 0
            ? 'Whoever made your models appears here once you record them.'
            : `${withModels.length} with models in your library`
        }
      />

      {creators.length === 0 ? (
        <EmptyState
          icon={<Users className="size-6" />}
          title="No creators recorded yet"
          description="Open a model, press Edit, and name whoever made it. They will appear here with everything of theirs you own."
          action={
            <Button asChild variant="secondary">
              <Link href="/models">Browse models</Link>
            </Button>
          }
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {withModels.map((creator) => (
              <Link
                key={creator.id}
                href={`/creators/${creator.slug}` as Route}
                className="block rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] transition-shadow hover:shadow-[var(--shadow-card)]"
              >
                <div className="flex items-center gap-3 p-4">
                  {creator.previewFileId ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`/api/files/${creator.previewFileId}/thumb`}
                      alt=""
                      className="size-12 shrink-0 rounded-[var(--radius-control)] bg-[var(--color-surface-2)] object-cover"
                    />
                  ) : (
                    <span className="flex size-12 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-surface-2)] text-[var(--color-ink-faint)]">
                      <Users className="size-5" />
                    </span>
                  )}
                  <div className="min-w-0">
                    <p className="truncate font-medium">{creator.name}</p>
                    <p className="text-xs text-[var(--color-ink-muted)]">
                      {creator.modelCount} model{creator.modelCount === 1 ? '' : 's'}
                    </p>
                  </div>
                </div>
              </Link>
            ))}
          </div>

          {/*
           * Creators with nothing attributed to them still exist — a tag was
           * removed, or a model was deleted. Worth showing quietly so they can
           * be noticed rather than silently orphaned.
           */}
          {empty.length > 0 && (
            <Card className="mt-6">
              <CardContent className="p-4">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-ink-faint)]">
                  No models attributed
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {empty.map((creator) => (
                    <span
                      key={creator.id}
                      className="rounded-full bg-[var(--color-surface-2)] px-2 py-0.5 text-xs text-[var(--color-ink-muted)]"
                    >
                      {creator.name}
                    </span>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </>
  )
}
