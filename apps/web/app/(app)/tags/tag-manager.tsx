'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { Route } from 'next'
import { Check, Combine, Loader2, Pencil, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Card } from '@/components/ui/card'
import { merge, recolour, remove, rename } from './actions'

/**
 * The tag list, with the management that keeps it usable.
 *
 * Merge is the important one. Tags arrive from filenames, sidecars and typing,
 * so a library reliably ends up with "dragon", "Dragon" and "dragons" meaning
 * the same thing — and a tag list nobody can tidy stops being worth filtering
 * by.
 */

export interface TagView {
  id: string
  name: string
  slug: string
  color: string | null
  modelCount: number
}

export function TagManager({ tags, canEdit }: { tags: TagView[]; canEdit: boolean }) {
  const router = useRouter()
  const [editing, setEditing] = useState<string | null>(null)
  const [merging, setMerging] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [target, setTarget] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function run(work: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null)
    startTransition(async () => {
      const result = await work()
      if (!result.ok) {
        setError(result.error ?? 'That did not work.')
        return
      }
      setEditing(null)
      setMerging(null)
      router.refresh()
    })
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}

      <Card className="overflow-hidden">
        <ul className="divide-y divide-[var(--color-border)]">
          {tags.map((tag) => (
            <li key={tag.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              {canEdit ? (
                <input
                  type="color"
                  aria-label={`Colour for ${tag.name}`}
                  value={tag.color ?? '#8899aa'}
                  onChange={(e) => run(() => recolour(tag.id, e.target.value))}
                  className="size-6 shrink-0 cursor-pointer rounded-full border border-[var(--color-border)] bg-transparent p-0"
                />
              ) : (
                <span
                  className="size-3 shrink-0 rounded-full ring-1 ring-inset ring-[var(--color-border)]"
                  style={{ backgroundColor: tag.color ?? 'var(--color-surface-2)' }}
                />
              )}

              {editing === tag.id ? (
                <>
                  <Input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') run(() => rename(tag.id, draft))
                      if (e.key === 'Escape') setEditing(null)
                    }}
                    className="h-8 max-w-56"
                  />
                  <Button size="sm" disabled={pending} onClick={() => run(() => rename(tag.id, draft))}>
                    {pending ? <Loader2 className="animate-spin" /> : <Check />}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                    <X />
                  </Button>
                </>
              ) : (
                <>
                  <Link
                    href={`/tags/${tag.slug}` as Route}
                    className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
                  >
                    {tag.name}
                  </Link>
                  <span className="shrink-0 text-xs tabular-nums text-[var(--color-ink-muted)]">
                    {tag.modelCount}
                  </span>

                  {canEdit && (
                    <div className="flex shrink-0 gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Rename ${tag.name}`}
                        onClick={() => {
                          setEditing(tag.id)
                          setDraft(tag.name)
                          setMerging(null)
                        }}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Merge ${tag.name} into another tag`}
                        onClick={() => {
                          setMerging(merging === tag.id ? null : tag.id)
                          setTarget('')
                        }}
                      >
                        <Combine />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${tag.name}`}
                        onClick={() => {
                          if (
                            confirm(
                              `Remove "${tag.name}" from ${tag.modelCount} model${
                                tag.modelCount === 1 ? '' : 's'
                              }? The models themselves are untouched.`,
                            )
                          ) {
                            run(() => remove(tag.id))
                          }
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  )}
                </>
              )}

              {merging === tag.id && (
                <div className="flex w-full items-center gap-2 pt-1">
                  <span className="shrink-0 text-xs text-[var(--color-ink-muted)]">
                    Move everything to
                  </span>
                  <Select
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    className="h-8 max-w-56"
                  >
                    <option value="">Choose a tag…</option>
                    {tags
                      .filter((other) => other.id !== tag.id)
                      .map((other) => (
                        <option key={other.id} value={other.id}>
                          {other.name}
                        </option>
                      ))}
                  </Select>
                  <Button
                    size="sm"
                    disabled={pending || !target}
                    onClick={() => run(() => merge(tag.id, target))}
                  >
                    Merge
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setMerging(null)}>
                    Cancel
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
