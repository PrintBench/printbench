'use client'

import { useState } from 'react'
import { ArchiveRestore } from 'lucide-react'
import { RestorePanel } from '@/components/backup/restore-panel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { LocalTime } from '@/components/ui/local-time'
import { createRestoreTicket } from './actions'

export interface BucketRow {
  /** `<instance id>/<name>`: what the worker is asked to fetch. */
  path: string
  instanceId: string
  name: string
  bytes: number
  createdAt: string | null
  appVersion: string | null
  keyId: string | null
  problem: string | null
}

/**
 * The backups in the bucket, newest first, each restorable in place.
 *
 * This instance's own come first. Other instances' folders are listed too —
 * after a move, the old server's backups are the ones worth restoring — but
 * this instance only ever writes to and prunes its own.
 *
 * One restore is open at a time: each panel holds its own staged upload, and
 * the worker keeps only one, so a second would silently replace the first.
 */
export function BucketList({
  rows,
  currentKeyId,
  instanceId,
}: {
  rows: BucketRow[]
  currentKeyId: string
  instanceId: string
}) {
  const [open, setOpen] = useState<string | null>(null)
  const own = rows.filter((row) => row.instanceId === instanceId)
  const others = rows.filter((row) => row.instanceId !== instanceId)

  return (
    <div className="space-y-6">
      {own.length === 0 ? (
        <p className="text-sm text-[var(--color-ink-muted)]">
          No backups from this instance yet. The first is taken at the next scheduled time, or press
          “Back up now”.
        </p>
      ) : (
        <Rows rows={own} currentKeyId={currentKeyId} open={open} setOpen={setOpen} />
      )}
      {others.length > 0 && (
        <div>
          <h3 className="text-sm font-medium">From other instances</h3>
          <p className="mb-1 text-xs text-[var(--color-ink-faint)]">
            Written by another PrintBench to this prefix, such as the server this one replaced. They
            can be restored here; this instance never deletes them.
          </p>
          <Rows rows={others} currentKeyId={currentKeyId} open={open} setOpen={setOpen} others />
        </div>
      )}
    </div>
  )
}

function Rows({
  rows,
  currentKeyId,
  open,
  setOpen,
  others = false,
}: {
  rows: BucketRow[]
  currentKeyId: string
  open: string | null
  setOpen: (path: string | null) => void
  others?: boolean
}) {
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
                {others && (
                  <span title={row.instanceId}>instance {row.instanceId.slice(0, 8)}</span>
                )}
                {!others && row.keyId && row.keyId !== currentKeyId && (
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
              <RestorePanel getTicket={createRestoreTicket} bucketBackup={row.path} />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-2"
                onClick={() => setOpen(null)}
              >
                Close
              </Button>
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
