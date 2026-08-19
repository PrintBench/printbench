'use client'

import { useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { createModelDownloadLink } from './download-actions'

/**
 * Downloads the whole model as a ZIP.
 *
 * The link is minted on click rather than rendered into the page: it carries a
 * short-lived signature, so baking it into the HTML would start the clock when
 * the page was rendered and leave a valid URL sitting in the DOM.
 */
export function DownloadModelButton({ publicId }: { publicId: string }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function download() {
    setPending(true)
    setError(null)
    try {
      const result = await createModelDownloadLink(publicId)
      if (!result.ok) {
        setError(result.error)
        return
      }
      // Navigating rather than fetching lets the browser own the download:
      // progress, pause and resume all come for free, and an 8 GB archive
      // never passes through JavaScript memory.
      window.location.href = result.url
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" disabled={pending} onClick={() => void download()}>
        {pending ? <Loader2 className="animate-spin" /> : <Download />}
        Download all
      </Button>
      {error && <span className="text-xs text-[var(--color-danger)]">{error}</span>}
    </div>
  )
}
