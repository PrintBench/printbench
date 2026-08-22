'use client'

import { useEffect, useState } from 'react'
import { ChevronRight, CornerLeftUp, Folder, FolderOpen, Loader2, Package } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { browseFolders } from '../actions'

/**
 * Pick a folder by looking at it.
 *
 * Replaces a text box that asked for "the path inside the container", which is
 * a question about our deployment rather than about their files. The server
 * already knows what is mounted and what is on it, so it shows that.
 *
 * Folders holding model files are marked, because the decision being made is
 * "which folder is my collection" and that is the only signal that answers it.
 */

interface Entry {
  name: string
  path: string
  entryCount: number
  looksLikeModels: boolean
}

export function FolderPicker({
  value,
  onChange,
}: {
  value: string
  onChange: (path: string) => void
}) {
  const [current, setCurrent] = useState<string | null>(null)
  const [parent, setParent] = useState<string | null>(null)
  const [entries, setEntries] = useState<Entry[]>([])
  const [roots, setRoots] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function open(target: string | null) {
    setLoading(true)
    setError(null)

    const result = await browseFolders(target)
    setLoading(false)

    if (!result.ok) {
      setError(result.error)
      return
    }

    setCurrent(result.result.current)
    setParent(result.result.parent)
    setEntries(result.result.directories)
    setRoots(result.result.roots)
  }

  useEffect(() => {
    void open(null)
    // Once, on mount: afterwards navigation is driven by clicks.
  }, [])

  return (
    <div className="rounded-[var(--radius-control)] border border-[var(--color-border)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
        <FolderOpen className="size-4 shrink-0 text-[var(--color-ink-faint)]" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={current ?? ''}>
          {current ?? 'Loading…'}
        </span>
        {parent && (
          <Button variant="ghost" size="sm" onClick={() => void open(parent)}>
            <CornerLeftUp />
            Up
          </Button>
        )}
      </div>

      {error ? (
        <div className="p-4">
          <p className="text-sm text-[var(--color-danger)]">{error}</p>
          <Button variant="secondary" size="sm" className="mt-2" onClick={() => void open(null)}>
            Start again
          </Button>
        </div>
      ) : loading ? (
        <p className="flex items-center gap-2 p-4 text-sm text-[var(--color-ink-muted)]">
          <Loader2 className="size-4 animate-spin" />
          Reading…
        </p>
      ) : (
        <>
          <ul className="max-h-72 divide-y divide-[var(--color-border)] overflow-y-auto">
            {entries.length === 0 && (
              <li className="p-4 text-sm text-[var(--color-ink-muted)]">
                No folders in here. If your models are directly in this folder, choose it as it is.
              </li>
            )}

            {entries.map((entry) => (
              <li key={entry.path} className="flex items-center gap-2 px-3 py-2">
                <button
                  type="button"
                  onClick={() => void open(entry.path)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm hover:text-[var(--color-accent)]"
                >
                  {entry.looksLikeModels ? (
                    <Package className="size-4 shrink-0 text-[var(--color-accent)]" />
                  ) : (
                    <Folder className="size-4 shrink-0 text-[var(--color-ink-faint)]" />
                  )}
                  <span className="truncate">{entry.name}</span>
                  {entry.entryCount === 0 && (
                    <span className="shrink-0 text-xs text-[var(--color-ink-faint)]">empty</span>
                  )}
                  <ChevronRight className="size-3 shrink-0 text-[var(--color-ink-faint)]" />
                </button>

                <Button
                  variant={value === entry.path ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => onChange(entry.path)}
                >
                  {value === entry.path ? 'Chosen' : 'Choose'}
                </Button>
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] px-3 py-2">
            <Button
              variant={value === current ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => current && onChange(current)}
            >
              {value === current ? 'This folder is chosen' : 'Choose this folder'}
            </Button>

            {/*
             * Shown only when there is more than one place to look. With a
             * single mount — the normal Docker setup — naming it would just
             * be repeating the path already on screen.
             */}
            {roots.length > 1 && (
              <div className="flex flex-wrap items-center gap-1">
                <span className="text-xs text-[var(--color-ink-faint)]">Jump to:</span>
                {roots.map((root) => (
                  <button
                    key={root}
                    type="button"
                    onClick={() => void open(root)}
                    className="rounded-full bg-[var(--color-surface-2)] px-2 py-0.5 font-mono text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
                  >
                    {root}
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
