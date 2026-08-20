'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Copy, Link2, Loader2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { createShareLink, revokeShareLink } from './share-actions'

/**
 * Share this model by link.
 *
 * The link is minted on demand rather than shown on every model page, because
 * an unshared model has no link and pretending otherwise would suggest the
 * whole library is public.
 */
export function ShareButton({
  publicId,
  shared,
  shareUrl,
}: {
  publicId: string
  shared: boolean
  /** Built on the server, which knows the configured public address. */
  shareUrl: string | null
}) {
  const router = useRouter()
  const [url, setUrl] = useState(shareUrl)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function share() {
    setError(null)
    startTransition(async () => {
      const result = await createShareLink(publicId)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setUrl(result.url)
      router.refresh()
    })
  }

  function revoke() {
    if (!confirm('Revoke this link? Anyone holding it will lose access immediately.')) return
    startTransition(async () => {
      const result = await revokeShareLink(publicId)
      if (!result.ok) setError(result.error ?? 'That did not work.')
      else {
        setUrl(null)
        router.refresh()
      }
    })
  }

  async function copy() {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access can be refused; the input below is selectable anyway.
      setError('Could not copy — select the link and copy it by hand.')
    }
  }

  return (
    <Popover onOpenChange={(open) => open && setError(null)}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm">
          <Link2 />
          <span className="hidden sm:inline">{shared || url ? 'Shared' : 'Share'}</span>
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-80 space-y-2 p-3">
        {url ? (
          <>
            <p className="text-xs text-[var(--color-ink-muted)]">
              Anyone with this link can view and download this model. Nothing else.
            </p>
            <input
              readOnly
              value={url}
              onFocus={(e) => e.currentTarget.select()}
              className="w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5 font-mono text-xs"
            />
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={copy}>
                {copied ? <Check /> : <Copy />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
              <Button size="sm" variant="ghost" onClick={revoke} disabled={pending}>
                <Trash2 />
                Revoke
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-xs text-[var(--color-ink-muted)]">
              Creates a private link to this model that works without an account.
            </p>
            <Button size="sm" onClick={share} disabled={pending}>
              {pending && <Loader2 className="animate-spin" />}
              Create a link
            </Button>
          </>
        )}

        {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}
      </PopoverContent>
    </Popover>
  )
}
