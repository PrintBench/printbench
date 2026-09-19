'use client'

import { useState } from 'react'
import Link from 'next/link'
import type { Route } from 'next'
import type { SearchHit } from '@pb/core'
import { ModelGrid } from '@/components/model/model-grid'
import { Button } from '@/components/ui/button'

interface CreatorItemSectionProps {
  creatorId: string
  type: 'model' | 'package'
  title: string
  initialItems: SearchHit[]
  total: number
  batchSize: number
  className?: string
}

export function CreatorItemSection({
  creatorId,
  type,
  title,
  initialItems,
  total,
  batchSize,
  className,
}: CreatorItemSectionProps) {
  const [expanded, setExpanded] = useState(true)
  const [items, setItems] = useState(initialItems)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hasMore = items.length < total

  async function showMore() {
    if (loading || !hasMore) return

    setLoading(true)
    setError(null)

    try {
      const params = new URLSearchParams({
        type,
        offset: String(items.length),
        limit: String(batchSize),
      })

      const response = await fetch(
        `/api/creators/${encodeURIComponent(creatorId)}/items?${params.toString()}`,
      )

      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`)
      }

      const data = (await response.json()) as {
        hits: SearchHit[]
        total: number
      }

      setItems((current) => {
        const existingIds = new Set(current.map((item) => item.id))
        const additional = data.hits.filter((item) => !existingIds.has(item.id))
        return [...current, ...additional]
      })
    } catch {
      setError('Could not load more items. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className={className}>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="mb-3 flex w-full items-center gap-2 text-left text-lg font-semibold"
      >
        <span aria-hidden className="w-4 text-sm text-[var(--color-ink-muted)]">
          {expanded ? '▼' : '▶'}
        </span>
        <span>
          {title} ({total.toLocaleString()})
        </span>
      </button>

      {expanded && (
        <>
          <ModelGrid models={items} />

          {hasMore && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <span className="text-sm text-[var(--color-ink-muted)]">
                Showing {items.length.toLocaleString()} of {total.toLocaleString()}.
              </span>

              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={loading}
                onClick={showMore}
              >
                {loading ? 'Loading…' : 'Show more'}
              </Button>

              <Link
                href={`/search?creator=${creatorId}` as Route}
                className="text-sm text-[var(--color-accent)] hover:underline"
              >
                See all in search
              </Link>
            </div>
          )}

          {error && (
            <p role="alert" className="mt-3 text-sm text-[var(--color-danger)]">
              {error}
            </p>
          )}
        </>
      )}
    </section>
  )
}
