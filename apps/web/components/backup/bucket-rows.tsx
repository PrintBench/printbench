'use client'

import { useState } from 'react'
import { ArchiveRestore } from 'lucide-react'
import type { BackupTicket, RestoreSource } from '@pb/core'
import type { BucketRow } from '@/lib/bucket-rows'
import { RestorePanel } from '@/components/backup/restore-panel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { LocalTime } from '@/components/ui/local-time'

type TicketResult = { ok: true; ticket: BackupTicket } | { ok: false; error: string }

/**
 * Backups in a bucket, each restorable in place.
 *
 * One restore is open at a time, so `open` belongs to whoever renders the
 * lists: each panel holds its own staged upload, and the worker keeps only
 * one, so a second would silently replace the first.
 */
export function BucketRows({
  rows,
  open,
  setOpen,
  getTicket,
  showInstance = false,
  currentKeyId,
  firstRun = false,
  source,
  onRestored,
}: {
  rows: BucketRow[]
  open: string | null
  setOpen: (path: string | null) => void
  getTicket: () => Promise<TicketResult>
  /** Show which instance wrote each one, when they are not all this one's. */
  showInstance?: boolean
  /** Flags backups taken under an older passphrase than the current one. */
  currentKeyId?: string
  firstRun?: boolean
  /** A bucket typed in for this restore rather than the schedule's. */
  source?: RestoreSource
  onRestored?: () => void
}) {
  // Once a restore has finished there is nothing to close back to: the
  // instance this list was read on has been replaced.
  const [restored, setRestored] = useState(false)

  return (
    <ul className="divide-y divide-[var(--color-border)]">
      {rows.map((row) => (
        <li key={row.path} className="py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0 text-sm">
              <div className="font-medium">
                {row.createdAt ? <LocalTime value={row.createdAt} /> : row.name}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-ink-faint)]">
                <span>{formatBytes(row.bytes)}</span>
                {row.appVersion && <span>PrintBench {row.appVersion}</span>}
                {showInstance && (
                  <span title={row.instanceId}>instance {row.instanceId.slice(0, 8)}</span>
                )}
                {currentKeyId && row.keyId && row.keyId !== currentKeyId && (
                  <Badge title="Taken before the passphrase was last changed">
                    Older passphrase
                  </Badge>
                )}
                {row.problem && <Badge tone="danger">{row.problem}</Badge>}
              </div>
            </div>
            {!row.problem && open !== row.path && (
              <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(row.path)}>
                <ArchiveRestore />
                Restore…
              </Button>
            )}
          </div>
          {open === row.path && (
            <div className="mt-3 rounded-[var(--radius-card)] border border-[var(--color-border)] p-4">
              {/* Closing unmounts the panel, which discards whatever it staged. */}
              <RestorePanel
                getTicket={getTicket}
                bucketBackup={row.path}
                bucketSource={source}
                firstRun={firstRun}
                onRestored={() => {
                  setRestored(true)
                  onRestored?.()
                }}
              />
              {!restored && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-2"
                  onClick={() => setOpen(null)}
                >
                  Close
                </Button>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(unit === 0 || value >= 100 ? 0 : 1)} ${units[unit]}`
}
