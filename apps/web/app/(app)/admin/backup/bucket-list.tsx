'use client'

import { useState } from 'react'
import { BucketRows } from '@/components/backup/bucket-rows'
import type { BucketRow } from '@/lib/bucket-rows'
import { createRestoreTicket } from './actions'

/**
 * The backups in the bucket, newest first, each restorable in place.
 *
 * This instance's own come first. Other instances' folders are listed too —
 * after a move, the old server's backups are the ones worth restoring — but
 * this instance only ever writes to and prunes its own.
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
  // Shared by both lists: one restore open at a time.
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
        <BucketRows
          rows={own}
          open={open}
          setOpen={setOpen}
          getTicket={createRestoreTicket}
          currentKeyId={currentKeyId}
        />
      )}
      {others.length > 0 && (
        <div>
          <h3 className="text-sm font-medium">From other instances</h3>
          <p className="mb-1 text-xs text-[var(--color-ink-faint)]">
            Written by another PrintBench to this prefix, such as the server this one replaced. They
            can be restored here; this instance never deletes them.
          </p>
          <BucketRows
            rows={others}
            open={open}
            setOpen={setOpen}
            getTicket={createRestoreTicket}
            showInstance
          />
        </div>
      )}
    </div>
  )
}
