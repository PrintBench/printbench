'use client'

import { useState } from 'react'
import { ChevronLeft, ExternalLink, Loader2 } from 'lucide-react'
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
 *
 * One component serves both placements. On a file row there is exactly one
 * candidate and it loads straight away; at the top of the model page there are
 * several, so the panel asks which file first. Splitting that into two
 * components would duplicate the link-minting and the caveats below it.
 */

export interface SlicerFile {
  id: string
  filename: string
}

interface Props {
  /** Files this slicer can open. Empty means the button is not rendered. */
  files: SlicerFile[]
  label?: string
  variant?: 'ghost' | 'secondary'
  /** Hide the label below the sm breakpoint, as the crowded file rows do. */
  compactLabel?: boolean
}

type Link = { id: string; label: string; url: string; hint: string }

export function OpenInSlicer({
  files,
  label = 'Open in…',
  variant = 'ghost',
  compactLabel = false,
}: Props) {
  const [chosen, setChosen] = useState<SlicerFile | null>(null)
  const [links, setLinks] = useState<Link[]>([])
  const [note, setNote] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (files.length === 0) return null
  const only = files.length === 1 ? files[0]! : null

  async function load(file: SlicerFile) {
    setChosen(file)
    setLoading(true)
    setError(null)
    setLinks([])

    const result = await createSlicerLinks(file.id)
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
          ? 'Sent as 3MF, the only format Bambu Studio accepts over a link.'
          : null,
    )
  }

  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) return
        // Fetched every time it opens, because the signature is short-lived.
        setError(null)
        setNote(null)
        setLinks([])
        setChosen(null)
        if (only) void load(only)
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant={variant}
          size="sm"
          title={only ? `Open ${only.filename} in a slicer` : 'Open a file in a slicer'}
        >
          {loading ? <Loader2 className="animate-spin" /> : <ExternalLink />}
          <span className={compactLabel ? 'hidden sm:inline' : undefined}>{label}</span>
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-72 p-1">
        {/* Several candidates and none picked yet: choose the file first. */}
        {!only && !chosen && (
          <>
            <p className="px-3 py-2 text-xs text-[var(--color-ink-faint)]">Which file?</p>
            <div className="max-h-64 overflow-y-auto">
              {files.map((file) => (
                <button
                  key={file.id}
                  type="button"
                  onClick={() => void load(file)}
                  className="block w-full truncate rounded-[var(--radius-control)] px-3 py-2 text-left text-sm hover:bg-[var(--color-surface-2)]"
                  title={file.filename}
                >
                  {file.filename}
                </button>
              ))}
            </div>
          </>
        )}

        {!only && chosen && (
          <button
            type="button"
            onClick={() => {
              setChosen(null)
              setLinks([])
              setError(null)
            }}
            className="flex w-full items-center gap-1 rounded-[var(--radius-control)] px-3 py-2 text-left text-xs text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-2)]"
          >
            <ChevronLeft className="size-3.5" />
            <span className="truncate">{chosen.filename}</span>
          </button>
        )}

        {error && <p className="p-3 text-xs text-[var(--color-danger)]">{error}</p>}

        {loading && !error && (
          <p className="p-3 text-xs text-[var(--color-ink-muted)]">Preparing links…</p>
        )}

        {(only || chosen) && !loading && !error && links.length === 0 && (
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
