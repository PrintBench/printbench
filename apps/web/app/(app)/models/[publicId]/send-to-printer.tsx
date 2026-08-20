'use client'

import { useState, useTransition } from 'react'
import { CheckCircle2, Loader2, Send, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { listPrintHosts, sendFileToPrinter } from './send-actions'

/**
 * Sends a sliced file to a configured printer.
 *
 * Only shown for files a printer can actually accept — gcode and friends. A
 * mesh goes through a slicer first, which is what the Open in… button is for.
 */

export function SendToPrinter({ fileId, filename }: { fileId: string; filename: string }) {
  const [hosts, setHosts] = useState<{ id: string; name: string }[]>([])
  const [loaded, setLoaded] = useState(false)
  const [startPrint, setStartPrint] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()

  function send(hostId: string) {
    setStatus(null)
    startTransition(async () => {
      const result = await sendFileToPrinter(fileId, hostId, startPrint)
      setStatus(result.ok ? { ok: true, text: result.message } : { ok: false, text: result.error })
    })
  }

  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) return
        // The result of the last send is stale the moment it is reopened.
        setStatus(null)
        if (loaded) return
        void listPrintHosts().then((found) => {
          setHosts(found)
          setLoaded(true)
        })
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" title={`Send ${filename} to a printer`}>
          <Send />
          <span className="hidden sm:inline">Send</span>
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-72 p-1">
        {!loaded ? (
          <p className="p-3 text-xs text-[var(--color-ink-muted)]">Looking for printers…</p>
        ) : hosts.length === 0 ? (
          <p className="p-3 text-xs text-[var(--color-ink-muted)]">
            No printers configured. An admin can add one under Manage → Printers.
          </p>
        ) : (
          <>
            <label className="flex items-center gap-2 px-3 py-2 text-xs text-[var(--color-ink-muted)]">
              <input
                type="checkbox"
                checked={startPrint}
                onChange={(e) => setStartPrint(e.target.checked)}
              />
              Start printing on arrival
            </label>

            <div className="border-t border-[var(--color-border)] pt-1">
              {hosts.map((host) => (
                <button
                  key={host.id}
                  type="button"
                  disabled={pending}
                  onClick={() => send(host.id)}
                  className="flex w-full items-center gap-2 rounded-[var(--radius-control)] px-3 py-2 text-left text-sm hover:bg-[var(--color-surface-2)] disabled:opacity-50"
                >
                  {pending && <Loader2 className="size-3 animate-spin" />}
                  {host.name}
                </button>
              ))}
            </div>
          </>
        )}

        {status && (
          <p
            className={`flex items-start gap-1.5 border-t border-[var(--color-border)] p-3 text-xs ${
              status.ok ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'
            }`}
          >
            {status.ok ? (
              <CheckCircle2 className="mt-0.5 size-3 shrink-0" />
            ) : (
              <XCircle className="mt-0.5 size-3 shrink-0" />
            )}
            {status.text}
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
