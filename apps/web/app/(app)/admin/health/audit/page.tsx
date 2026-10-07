import { Download, ScrollText } from 'lucide-react'
import type { Route } from 'next'
import Link from 'next/link'
import {
  AUDIT_CATEGORIES,
  auditCategory,
  auditLabel,
  listAuditEvents,
  type AuditCategory,
  type AuditEvent,
} from '@pb/core'
import { getDb } from '@pb/db'
import { diagnosticsUser } from '@/lib/diagnostics'
import { PageHeader } from '@/components/shell/page-header'
import { NotPermitted } from '@/components/shell/not-permitted'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { LocalTime } from '@/components/ui/local-time'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Audit trail' }

const PAGE_SIZE = 50

interface Params {
  category?: string
  outcome?: string
  q?: string
  page?: string
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<Params> }) {
  if (!(await diagnosticsUser())) return <NotPermitted what="the audit trail" />

  const params = await searchParams
  const category =
    params.category && params.category in AUDIT_CATEGORIES
      ? (params.category as AuditCategory)
      : undefined
  const outcome =
    params.outcome === 'failure' || params.outcome === 'success' ? params.outcome : undefined
  const query = params.q?.trim().slice(0, 200) || undefined
  const page = Math.max(1, Math.floor(Number(params.page)) || 1)

  const { events, total } = await listAuditEvents(getDb(), {
    category,
    outcome,
    query,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  })

  const filters = {
    ...(category ? { category } : {}),
    ...(outcome ? { outcome } : {}),
    ...(query ? { q: query } : {}),
  }
  const filtered = Object.keys(filters).length > 0
  const pageHref = (target: number) =>
    `/admin/health/audit?${new URLSearchParams({ ...filters, page: String(target) })}` as Route
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <>
      <PageHeader
        title="Audit trail"
        description={
          total === 0 && !filtered
            ? 'A record of sign-ins and changes, newest first.'
            : `${total.toLocaleString('en-GB')} event${total === 1 ? '' : 's'}${filtered ? ' matching' : ''}, newest first.`
        }
        actions={
          <Button asChild variant="secondary" size="sm">
            <a href={`/api/admin/audit/export?${new URLSearchParams(filters)}`} download>
              <Download />
              Export CSV
            </a>
          </Button>
        }
      />

      <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
        <div className="w-44">
          <Select name="category" defaultValue={category ?? ''} aria-label="Category">
            <option value="">Everything</option>
            {Object.entries(AUDIT_CATEGORIES).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-40">
          <Select name="outcome" defaultValue={outcome ?? ''} aria-label="Outcome">
            <option value="">Any outcome</option>
            <option value="success">Succeeded</option>
            <option value="failure">Failed or refused</option>
          </Select>
        </div>
        <div className="min-w-48 flex-1">
          <Input
            name="q"
            type="search"
            defaultValue={query ?? ''}
            placeholder="Search by person, item or IP address"
            aria-label="Search the audit trail"
          />
        </div>
        <Button type="submit" variant="secondary">
          Filter
        </Button>
        {filtered && (
          <Button asChild variant="ghost">
            <Link href="/admin/health/audit">Clear</Link>
          </Button>
        )}
      </form>

      {events.length === 0 ? (
        <EmptyState
          icon={<ScrollText />}
          title={filtered ? 'Nothing matches' : 'Nothing recorded yet'}
          description={
            filtered
              ? 'No events match this filter.'
              : 'Sign-ins, edits, deletions, scans and prints are recorded here from now on.'
          }
        />
      ) : (
        <Card className="divide-y divide-[var(--color-border)]">
          {events.map((event) => (
            <AuditRow key={event.id} event={event} />
          ))}
        </Card>
      )}

      {pages > 1 && (
        <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Pages">
          {page > 1 ? (
            <Button asChild variant="secondary" size="sm">
              <Link href={pageHref(page - 1)}>Newer</Link>
            </Button>
          ) : (
            <span />
          )}
          <span className="text-[var(--color-ink-muted)]">
            Page {page} of {pages}
          </span>
          {page < pages ? (
            <Button asChild variant="secondary" size="sm">
              <Link href={pageHref(page + 1)}>Older</Link>
            </Button>
          ) : (
            <span />
          )}
        </nav>
      )}
    </>
  )
}

function actorName(event: AuditEvent): string {
  if (event.actorType === 'system') return 'PrintBench'
  if (event.actorType === 'anonymous') return event.actorName ?? 'Someone not signed in'
  return event.actorName ?? 'A deleted user'
}

/** A model that still exists can be opened; one that was just deleted cannot. */
function targetHref(event: AuditEvent): Route | null {
  if (event.targetType !== 'model' || !event.targetId) return null
  if (event.action === 'model.deleted' || event.action === 'model.files_deleted') return null
  return `/models/${event.targetId}` as Route
}

function detailEntries(detail: unknown): [string, string][] {
  if (!detail || typeof detail !== 'object') return []
  return Object.entries(detail as Record<string, unknown>)
    .filter(([, value]) => value !== null && value !== '' && value !== 0 && value !== false)
    .map(([key, value]) => [
      // modelsAdded -> models added
      key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase(),
      typeof value === 'object' ? JSON.stringify(value) : String(value),
    ])
}

function AuditRow({ event }: { event: AuditEvent }) {
  const href = targetHref(event)
  const details = detailEntries(event.detail)
  const category = auditCategory(event.action)

  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-1 px-4 py-3 text-sm">
      <LocalTime
        value={event.occurredAt.toISOString()}
        seconds
        className="w-44 shrink-0 tabular-nums text-[var(--color-ink-muted)]"
      />
      <div className="min-w-0 flex-1">
        <p>
          <span className="font-medium">{actorName(event)}</span>{' '}
          <span className="text-[var(--color-ink-muted)]">
            {event.actorType === 'anonymous' ? '· ' : ''}
            {auditLabel(event.action)}
          </span>
          {event.targetLabel && (
            <>
              {' · '}
              {href ? (
                <Link href={href} className="font-medium hover:underline">
                  {event.targetLabel}
                </Link>
              ) : (
                <span className="font-medium">{event.targetLabel}</span>
              )}
            </>
          )}
        </p>
        {details.length > 0 && (
          <p className="mt-0.5 break-words text-xs text-[var(--color-ink-muted)]">
            {details.map(([key, value]) => `${key}: ${value}`).join(' · ')}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {event.ip && (
          <span className="font-mono text-xs text-[var(--color-ink-faint)]">{event.ip}</span>
        )}
        {event.outcome === 'failure' && <Badge tone="danger">Failed</Badge>}
        {category && <Badge>{AUDIT_CATEGORIES[category]}</Badge>}
      </div>
    </div>
  )
}
