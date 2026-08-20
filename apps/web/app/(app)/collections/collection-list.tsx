'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { Route } from 'next'
import { Check, FolderTree, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { create, remove, rename } from './actions'

/**
 * Collections, shown as a tree.
 *
 * Nesting exists because a Kickstarter pledge is genuinely a collection of
 * collections — "Wave 2" inside "Dragon Kickstarter" — and flattening that
 * loses the only structure the creator gave you.
 */

export interface CollectionView {
  id: string
  name: string
  slug: string
  caption: string | null
  parentId: string | null
  modelCount: number
  previewFileId: string | null
}

export function CollectionList({
  collections,
  canEdit,
}: {
  collections: CollectionView[]
  canEdit: boolean
}) {
  const router = useRouter()
  const [adding, setAdding] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [parentId, setParentId] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  // Children keyed by parent, so the tree can be walked without re-scanning.
  const byParent = new Map<string | null, CollectionView[]>()
  for (const collection of collections) {
    const siblings = byParent.get(collection.parentId) ?? []
    siblings.push(collection)
    byParent.set(collection.parentId, siblings)
  }

  function run(work: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null)
    startTransition(async () => {
      const result = await work()
      if (!result.ok) {
        setError(result.error ?? 'That did not work.')
        return
      }
      setAdding(false)
      setEditing(null)
      setDraftName('')
      router.refresh()
    })
  }

  function renderTree(parent: string | null, depth: number): React.ReactNode {
    const children = byParent.get(parent) ?? []
    if (children.length === 0) return null

    return children.map((collection) => {
      // Computed once: calling renderTree in both the test and the body walks
      // the whole subtree twice at every level.
      const nested = renderTree(collection.id, depth + 1)

      return (
      <li key={collection.id}>
        <div
          className="flex items-center gap-3 px-4 py-2.5"
          style={{ paddingLeft: `${16 + depth * 20}px` }}
        >
          {collection.previewFileId ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/files/${collection.previewFileId}/thumb`}
              alt=""
              className="size-8 shrink-0 rounded bg-[var(--color-surface-2)] object-cover"
            />
          ) : (
            <FolderTree className="size-4 shrink-0 text-[var(--color-ink-faint)]" />
          )}

          {editing === collection.id ? (
            <>
              <Input
                autoFocus
                value={editDraft}
                onChange={(e) => setEditDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') run(() => rename(collection.id, editDraft))
                  if (e.key === 'Escape') setEditing(null)
                }}
                className="h-8 max-w-64"
              />
              <Button size="sm" disabled={pending} onClick={() => run(() => rename(collection.id, editDraft))}>
                <Check />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                <X />
              </Button>
            </>
          ) : (
            <>
              <div className="min-w-0 flex-1">
                <Link
                  href={`/collections/${collection.slug}` as Route}
                  className="truncate text-sm font-medium hover:underline"
                >
                  {collection.name}
                </Link>
                {collection.caption && (
                  <p className="truncate text-xs text-[var(--color-ink-faint)]">
                    {collection.caption}
                  </p>
                )}
              </div>
              <span className="shrink-0 text-xs tabular-nums text-[var(--color-ink-muted)]">
                {collection.modelCount}
              </span>

              {canEdit && (
                <div className="flex shrink-0 gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Add a collection inside ${collection.name}`}
                    onClick={() => {
                      setAdding(true)
                      setParentId(collection.id)
                      setDraftName('')
                    }}
                  >
                    <Plus />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Rename ${collection.name}`}
                    onClick={() => {
                      setEditing(collection.id)
                      setEditDraft(collection.name)
                    }}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${collection.name}`}
                    onClick={() => {
                      if (
                        confirm(
                          `Remove "${collection.name}"? The models stay where they are, and anything nested inside moves up a level.`,
                        )
                      ) {
                        run(() => remove(collection.id))
                      }
                    }}
                  >
                    <Trash2 />
                  </Button>
                </div>
              )}
            </>
          )}
        </div>

        {nested && (
          <ul className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
            {nested}
          </ul>
        )}
      </li>
      )
    })
  }

  return (
    <div className="space-y-3">
      {canEdit && !adding && (
        <Button
          size="sm"
          onClick={() => {
            setAdding(true)
            setParentId(null)
            setDraftName('')
          }}
        >
          <Plus />
          New collection
        </Button>
      )}

      {adding && (
        <Card>
          <div className="flex flex-wrap items-center gap-2 p-3">
            <Input
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') run(() => create({ name: draftName, parentId }))
                if (e.key === 'Escape') setAdding(false)
              }}
              placeholder={parentId ? 'Name of the nested collection' : 'Name of the collection'}
              className="h-9 max-w-72"
            />
            <Button
              size="sm"
              disabled={pending}
              onClick={() => run(() => create({ name: draftName, parentId }))}
            >
              {pending ? <Loader2 className="animate-spin" /> : <Check />}
              Create
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            {parentId && (
              <span className="text-xs text-[var(--color-ink-faint)]">
                inside {collections.find((c) => c.id === parentId)?.name}
              </span>
            )}
          </div>
        </Card>
      )}

      {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}

      <Card className="overflow-hidden">
        <ul className="divide-y divide-[var(--color-border)]">{renderTree(null, 0)}</ul>
      </Card>
    </div>
  )
}
