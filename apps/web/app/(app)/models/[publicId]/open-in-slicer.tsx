'use client'

import { useState } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { createSlicerLinks } from './print-actions'

/**
 * Hands a file to a desktop slicer.
 *
 * Every modern slicer registers a URL scheme, so this needs no agent, no plugin
 * and no printer API — and it works for Bambu, whose printers have no simple
 * HTTP upload of their own.
 *
 * The links are minted on open rather than rendered into the page: they carry
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
  const [note, setNote] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)

    const result = await createSlicerLinks(fileId)
    setLoading(false)

    if (!result.ok) {
      setError(result.error)
      return
    }
    setLinks(result.links)

    /*
     * Said out loud, because the slicer will show a .3mf and the file on this
     * page is an STL. Bambu Studio refuses anything else before it downloads,
     * so the conversion is not optional — but it should not be a surprise.
     */
    setNote(
      result.lossy
        ? 'Sent as 3MF. Geometry is preserved; colours and materials are not.'
        : result.converted
          ? 'Sent as 3MF — the only format Bambu Studio accepts over a link.'
          : null,
    )
  }

  return (
    <Popover
      onOpenChange={(open) => {
        // Fetched every time it opens, because the signature is short-lived.
        if (open) void load()
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" title={`Open ${filename} in a slicer`}>
          {loading ? <Loader2 className="animate-spin" /> : <ExternalLink />}
          <span className="hidden sm:inline">Open in…</span>
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-64 p-1">
        {error && <p className="p-3 text-xs text-[var(--color-danger)]">{error}</p>}

        {loading && !error && (
          <p className="p-3 text-xs text-[var(--color-ink-muted)]">Preparing links…</p>
        )}

        {!loading && !error && links.length === 0 && (
          <p className="p-3 text-xs text-[var(--color-ink-muted)]">No slicer opens this format.</p>
        )}

        {links.map((link) => (
          <a
            key={link.id}
            href={link.url}
            className="block rounded-[var(--radius-control)] px-3 py-2 text-sm hover:bg-[var(--color-surface-2)]"
          >
            {link.label}
          </a>
        ))}

        {links.length > 0 && (
          <div className="border-t border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-ink-faint)]">
            {note && <p className="mb-1">{note}</p>}
            <p>Nothing happens? The slicer is not installed, or your browser blocked the link.</p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
