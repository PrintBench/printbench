'use client'

import { useState } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { createSlicerLinks } from './print-actions'

/**
 * Hands a file to a desktop slicer.
 *
 * Every modern slicer registers a URL scheme, so this needs no agent, no plugin
 * and no printer API — and it works for Bambu, whose printers have no simple
 * HTTP upload of their own.
 *
 * The links are minted on click rather than rendered into the page: they carry
 * a signature that expires, and a link baked into HTML would be dead by the
 * time someone returned to the tab. The failure would be silent, too — the
 * slicer would just open empty.
 */

interface Props {
  fileId: string
  filename: string
}

export function OpenInSlicer({ fileId, filename }: Props) {
  const [links, setLinks] = useState<{ id: string; label: string; url: string; hint: string }[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function toggle() {
    if (open) {
      setOpen(false)
      return
    }

    setLoading(true)
    setError(null)
    const result = await createSlicerLinks(fileId)
    setLoading(false)

    if (!result.ok) {
      setError(result.error)
      setOpen(true)
      return
    }
    setLinks(result.links)
    setOpen(true)
  }

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="sm"
        onClick={toggle}
        aria-expanded={open}
        title={`Open ${filename} in a slicer`}
      >
        {loading ? <Loader2 className="animate-spin" /> : <ExternalLink />}
        <span className="hidden sm:inline">Open in…</span>
      </Button>

      {open && (
        <div
          className="absolute right-0 top-full z-20 mt-1 w-64 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-lg"
          onMouseLeave={() => setOpen(false)}
        >
          {error && <p className="p-3 text-xs text-[var(--color-danger)]">{error}</p>}

          {!error && links.length === 0 && (
            <p className="p-3 text-xs text-[var(--color-ink-muted)]">
              No slicer opens this format.
            </p>
          )}

          {links.map((link) => (
            <a
              key={link.id}
              href={link.url}
              className="block rounded-[var(--radius-control)] px-3 py-2 text-sm hover:bg-[var(--color-surface-2)]"
              onClick={() => setOpen(false)}
            >
              {link.label}
            </a>
          ))}

          {links.length > 0 && (
            <p className="border-t border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-ink-faint)]">
              Nothing happens? The slicer is not installed, or your browser blocked the link.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
