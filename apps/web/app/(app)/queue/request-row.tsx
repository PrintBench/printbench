'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  Check,
  CircleSlash,
  Play,
  Printer,
  RotateCcw,
  Trash2,
  Undo2,
  type LucideIcon,
} from 'lucide-react'
import type { PrintRequestPriority, PrintRequestStatus } from '@pb/core/requests'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { LinkPicker } from './link-picker'
import { removeRequest, setRequestModel, setStatus } from './actions'

export interface QueueRow {
  id: string
  title: string
  notes: string | null
  requestedBy: string | null
  quantity: number
  priority: PrintRequestPriority
  status: PrintRequestStatus
  material: string | null
  colorHex: string | null
  /** ISO strings: Dates do not need to survive the round trip, only render. */
  dueAt: string | null
  createdAt: string
  /** Set once marking it printed has written it to the print history. */
  printRunId: string | null
  modelPublicId: string | null
  modelName: string | null
  modelMissing: boolean
  thumbFileId: string | null
  filename: string | null
  /** True when the signed-in user raised this one. */
  mine: boolean
}

const STATUS_META: Record<PrintRequestStatus, { label: string; icon: LucideIcon; class: string }> =
  {
    requested: {
      label: 'Waiting',
      icon: Printer,
      class: 'text-[var(--color-ink-faint)]',
    },
    printing: { label: 'Printing', icon: Play, class: 'text-[var(--color-accent)]' },
    done: { label: 'Printed', icon: Check, class: 'text-[var(--color-success)]' },
    cancelled: { label: 'Cancelled', icon: CircleSlash, class: 'text-[var(--color-ink-faint)]' },
  }

export function RequestRow({ request, canRun }: { request: QueueRow; canRun: boolean }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  /*
   * Anyone signed in may raise a request, so the person looking at this row is
   * not necessarily allowed to act on it. Editing and cancelling follow
   * authorship; starting and finishing a print follow the role. The server
   * enforces both — this only decides what is worth rendering.
   */
  const canEdit = canRun || request.mine

  const meta = STATUS_META[request.status]
  const Icon = meta.icon
  const closed = request.status === 'done' || request.status === 'cancelled'
  const overdue = !closed && request.dueAt != null && new Date(request.dueAt) < new Date()

  function run(work: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null)
    startTransition(async () => {
      const result = await work()
      if (!result.ok) {
        setError(result.error ?? 'That did not work.')
        return
      }
      router.refresh()
    })
  }

  const details = [
    request.requestedBy && `for ${request.requestedBy}`,
    request.material,
    request.filename,
    request.dueAt &&
      `${overdue ? 'was due' : 'due'} ${new Date(request.dueAt).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
      })}`,
  ].filter(Boolean) as string[]

  return (
    <li className={cn('flex flex-wrap items-start gap-3 px-4 py-3', closed && 'opacity-60')}>
      {request.thumbFileId ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/files/${request.thumbFileId}/thumb`}
          alt=""
          className="size-10 shrink-0 rounded bg-[var(--color-surface-2)] object-cover"
        />
      ) : (
        <span className="flex size-10 shrink-0 items-center justify-center rounded bg-[var(--color-surface-2)]">
          <Icon className={cn('size-4', meta.class)} />
        </span>
      )}

      <div className="min-w-0 flex-1 basis-64">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cn('text-sm font-medium', closed && 'line-through')}>
            {request.title}
          </span>
          {request.quantity > 1 && <Badge tone="neutral">×{request.quantity}</Badge>}
          {request.priority === 'high' && !closed && <Badge tone="danger">Urgent</Badge>}
          {request.priority === 'low' && !closed && <Badge tone="neutral">Low</Badge>}
          {overdue && <Badge tone="danger">Overdue</Badge>}
          {request.colorHex && (
            <span
              title={request.colorHex}
              className="size-3 rounded-full ring-1 ring-inset ring-[var(--color-border)]"
              style={{ backgroundColor: request.colorHex }}
            />
          )}
        </div>

        <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">
          {/*
           * The state of the library link is the thing worth saying on every
           * row: a request nobody can find a file for is the one that stalls,
           * and it should be visible without opening anything.
           */}
          {request.modelPublicId ? (
            <>
              <Link
                href={`/models/${request.modelPublicId}`}
                className="text-[var(--color-accent)] hover:underline"
              >
                {request.modelName}
              </Link>
              {request.modelMissing && ' — missing from disk'}
              {details.length > 0 && ` · ${details.join(' · ')}`}
            </>
          ) : (
            <>
              <span className="text-[var(--color-ink-faint)]">Not in the library yet</span>
              {details.length > 0 && ` · ${details.join(' · ')}`}
            </>
          )}
        </p>

        {request.notes && (
          <p className="mt-1 line-clamp-2 text-sm text-[var(--color-ink-muted)]">{request.notes}</p>
        )}

        {error && <p className="mt-1 text-xs text-[var(--color-danger)]">{error}</p>}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1">
        {closed ? (
          <>
            <span className="mr-1 text-xs text-[var(--color-ink-faint)]">
              {meta.label}
              {/* Say so rather than leaving it to be discovered: the print
                  history gained a row because of this button. */}
              {request.printRunId && ' · logged'}
            </span>
            {canEdit && (
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                aria-label={`Reopen ${request.title}`}
                onClick={() => run(() => setStatus(request.id, 'requested'))}
              >
                <RotateCcw />
                <span className="hidden sm:inline">Reopen</span>
              </Button>
            )}
          </>
        ) : (
          <>
            {canRun && request.status === 'requested' && (
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                aria-label={`Start printing ${request.title}`}
                onClick={() => run(() => setStatus(request.id, 'printing'))}
              >
                <Play />
                <span className="hidden sm:inline">Start</span>
              </Button>
            )}

            {canRun && request.status === 'printing' && (
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                aria-label={`Put ${request.title} back in the queue`}
                onClick={() => run(() => setStatus(request.id, 'requested'))}
              >
                <Undo2 />
                <span className="hidden sm:inline">Back to queue</span>
              </Button>
            )}

            {canRun && (
              <Button
                variant="secondary"
                size="sm"
                disabled={pending}
                aria-label={
                  request.modelPublicId
                    ? `Mark ${request.title} printed and add it to the print history`
                    : `Mark ${request.title} printed`
                }
                title={
                  request.modelPublicId
                    ? 'Also records this in the print history'
                    : 'Link a model to have this recorded in the print history'
                }
                onClick={() => run(() => setStatus(request.id, 'done'))}
              >
                <Check />
                <span className="hidden sm:inline">Printed</span>
              </Button>
            )}

            {canEdit && (
              <LinkPicker
                linkedName={request.modelName}
                suggestQuery={request.title}
                pending={pending}
                onLink={(modelId) => run(() => setRequestModel(request.id, modelId))}
              />
            )}

            {canEdit && (
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                aria-label={`Cancel ${request.title}`}
                onClick={() => run(() => setStatus(request.id, 'cancelled'))}
              >
                <CircleSlash />
              </Button>
            )}
          </>
        )}

        {canEdit && (
          <Button
            variant="ghost"
            size="icon"
            disabled={pending}
            aria-label={`Remove ${request.title}`}
            onClick={() => {
              /*
               * Cancelling keeps the record and is what people usually mean.
               * Deleting is for a request that should never have existed, so
               * it is the one that asks.
               */
              if (confirm(`Remove "${request.title}" from the queue entirely?`)) {
                run(() => removeRequest(request.id))
              }
            }}
          >
            <Trash2 />
          </Button>
        )}
      </div>
    </li>
  )
}
