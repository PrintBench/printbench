'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Check, FolderPlus, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { create, setMembership } from '../../collections/actions'

/**
 * Puts this model into collections.
 *
 * Membership is edited from the model rather than the collection because that
 * is where you are when you decide: you have just opened something and
 * realised it belongs with the rest of the pledge.
 */
export function CollectionPicker({
  publicId,
  collections,
  memberOf,
}: {
  publicId: string
  collections: { id: string; name: string }[]
  memberOf: string[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const member = new Set(memberOf)

  function toggle(collectionId: string, next: boolean) {
    setError(null)
    startTransition(async () => {
      const result = await setMembership(collectionId, publicId, next)
      if (!result.ok) setError(result.error)
      else router.refresh()
    })
  }

  function addNew() {
    setError(null)
    startTransition(async () => {
      const created = await create({ name })
      if (!created.ok) {
        setError(created.error)
        return
      }
      /*
       * Created, then joined. create() returns the slug rather than the id, so
       * a refresh is what puts the new collection in the list with its id —
       * and the membership call needs that id.
       */
      setName('')
      setCreating(false)
      router.refresh()
    })
  }

  return (
    <div className="relative">
      <Button variant="ghost" size="sm" onClick={() => setOpen(!open)} aria-expanded={open}>
        <FolderPlus />
        <span className="hidden sm:inline">Collections</span>
      </Button>

      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-72 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-2 shadow-lg">
          {collections.length === 0 && !creating && (
            <p className="p-2 text-xs text-[var(--color-ink-muted)]">
              No collections yet. Create one below.
            </p>
          )}

          <div className="max-h-64 overflow-y-auto">
            {collections.map((collection) => (
              <label
                key={collection.id}
                className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-control)] px-2 py-1.5 text-sm hover:bg-[var(--color-surface-2)]"
              >
                <input
                  type="checkbox"
                  checked={member.has(collection.id)}
                  disabled={pending}
                  onChange={(e) => toggle(collection.id, e.target.checked)}
                />
                <span className="min-w-0 truncate">{collection.name}</span>
              </label>
            ))}
          </div>

          <div className="mt-1 border-t border-[var(--color-border)] pt-2">
            {creating ? (
              <div className="flex gap-1.5">
                <Input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addNew()
                    if (e.key === 'Escape') setCreating(false)
                  }}
                  placeholder="New collection"
                  className="h-8"
                />
                <Button size="sm" disabled={pending || !name.trim()} onClick={addNew}>
                  {pending ? <Loader2 className="animate-spin" /> : <Check />}
                </Button>
              </div>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setCreating(true)}>
                <FolderPlus />
                New collection
              </Button>
            )}
          </div>

          {error && <p className="px-2 pt-2 text-xs text-[var(--color-danger)]">{error}</p>}
        </div>
      )}
    </div>
  )
}
