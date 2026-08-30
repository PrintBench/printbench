import Link from 'next/link'
import type { Route } from 'next'
import { ClipboardList } from 'lucide-react'
import {
  can,
  listRequests,
  queueStats,
  requesterSuggestions,
  type PrintRequestStatus,
} from '@pb/core'
import { getSessionUser } from '@pb/auth'
import { getDb } from '@pb/db'
import { PageHeader } from '@/components/shell/page-header'
import { NotPermitted } from '@/components/shell/not-permitted'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { AddRequests } from './add-requests'
import { RequestRow, type QueueRow } from './request-row'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Print queue' }

const FILTERS: { key: string; label: string; status?: PrintRequestStatus[] }[] = [
  { key: 'open', label: 'To print', status: ['requested', 'printing'] },
  { key: 'printing', label: 'On the printer', status: ['printing'] },
  { key: 'done', label: 'Printed', status: ['done'] },
  { key: 'cancelled', label: 'Cancelled', status: ['cancelled'] },
  { key: 'all', label: 'Everything' },
]

export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>
}) {
  const user = await getSessionUser()
  const policyUser = { id: user?.id ?? '', role: user?.role ?? null }

  if (!user || !can(policyUser, 'request:create')) {
    return <NotPermitted what="the print queue" />
  }

  const params = await searchParams
  const filter = FILTERS.find((option) => option.key === params.filter) ?? FILTERS[0]!

  const db = getDb()
  const [requests, stats, requesters] = await Promise.all([
    listRequests(db, { status: filter.status, limit: 200 }),
    queueStats(db),
    requesterSuggestions(db),
  ])

  // Working the queue is a member's job; asking is open to anyone signed in.
  const canRun = can(policyUser, 'request:manage')
  const empty = stats.waiting + stats.printing + stats.done + stats.cancelled === 0

  const rows: QueueRow[] = requests.map((request) => ({
    id: request.id,
    title: request.title,
    notes: request.notes,
    requestedBy: request.requestedBy,
    quantity: request.quantity,
    priority: request.priority,
    status: request.status,
    material: request.material,
    colorHex: request.colorHex,
    dueAt: request.dueAt?.toISOString() ?? null,
    createdAt: request.createdAt.toISOString(),
    printRunId: request.printRunId,
    modelPublicId: request.modelPublicId,
    modelName: request.modelName,
    modelMissing: request.modelMissing,
    thumbFileId: request.thumbFileId,
    filename: request.filename,
    mine: request.createdBy === user.id,
  }))

  return (
    <>
      <PageHeader
        title="Print queue"
        description={empty ? 'Things people have asked you to print.' : summarise(stats)}
      />

      <div className="mb-4">
        <AddRequests requesterSuggestions={requesters} />
      </div>

      {!empty && (
        <nav className="mb-4 flex flex-wrap gap-1.5">
          {FILTERS.map((option) => (
            <Link
              key={option.key}
              href={`/queue?filter=${option.key}` as Route}
              aria-current={option.key === filter.key ? 'page' : undefined}
              className={
                option.key === filter.key
                  ? 'rounded-full bg-[var(--color-accent-soft)] px-3 py-1 text-sm font-medium text-[var(--color-accent)]'
                  : 'rounded-full px-3 py-1 text-sm text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-2)]'
              }
            >
              {option.label}
            </Link>
          ))}
        </nav>
      )}

      {rows.length === 0 ? (
        /*
         * An empty queue and an empty filter are different things, and saying
         * "nothing to print" while the header counts eleven finished prints
         * would simply be wrong.
         */
        <EmptyState
          icon={<ClipboardList className="size-6" />}
          title={empty ? 'Nothing in the queue' : `Nothing ${filter.label.toLowerCase()}`}
          description={
            empty
              ? 'When someone asks you to print something, put it here. Requests do not need a file — add what they asked for and link it to your library later, if the model turns up.'
              : 'Nothing in the queue matches this filter.'
          }
          action={
            empty ? undefined : (
              <Link
                href={'/queue' as Route}
                className="text-sm text-[var(--color-accent)] hover:underline"
              >
                Show everything
              </Link>
            )
          }
        />
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-[var(--color-border)]">
            {rows.map((request) => (
              <RequestRow key={request.id} request={request} canRun={canRun} />
            ))}
          </ul>
        </Card>
      )}
    </>
  )
}

function summarise(stats: {
  waiting: number
  printing: number
  done: number
  overdue: number
}): string {
  const parts: string[] = []
  if (stats.waiting > 0) parts.push(`${stats.waiting} waiting`)
  if (stats.printing > 0) parts.push(`${stats.printing} on the printer`)
  if (stats.overdue > 0) parts.push(`${stats.overdue} overdue`)
  if (stats.done > 0) parts.push(`${stats.done} printed`)

  // Everything is closed: the queue is clear, which is worth saying outright.
  return parts.length > 0 ? parts.join(' · ') : 'Nothing waiting — the queue is clear.'
}
