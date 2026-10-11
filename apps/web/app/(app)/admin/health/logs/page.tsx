import { Download, Terminal } from 'lucide-react'
import type { Route } from 'next'
import Link from 'next/link'
import { isLogLevel, listLogs, type LogEntry, type LogLevel } from '@pb/core'
import { getDb } from '@pb/db'
import { diagnosticsUser } from '@/lib/diagnostics'
import { cn } from '@/lib/cn'
import { PageHeader } from '@/components/shell/page-header'
import { NotPermitted } from '@/components/shell/not-permitted'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { LocalTime } from '@/components/ui/local-time'
import { LiveRefresh } from './live-refresh'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Logs' }

const PAGE_SIZE = 200

interface Params {
  level?: string
  source?: string
  q?: string
  before?: string
}

const LEVEL_CLASS: Record<LogLevel, string> = {
  debug: 'text-[var(--color-ink-faint)]',
  info: 'text-[var(--color-ink-muted)]',
  warn: 'text-[var(--color-warning)]',
  error: 'text-[var(--color-danger)]',
}

export default async function LogsPage({ searchParams }: { searchParams: Promise<Params> }) {
  if (!(await diagnosticsUser())) return <NotPermitted what="the application logs" />

  const params = await searchParams
  const minLevel = isLogLevel(params.level) ? params.level : undefined
  const source = params.source === 'web' || params.source === 'worker' ? params.source : undefined
  const query = params.q?.trim().slice(0, 200) || undefined
  const before = Math.floor(Number(params.before)) || undefined

  const entries = await listLogs(getDb(), {
    minLevel,
    source,
    query,
    beforeId: before,
    limit: PAGE_SIZE,
  })

  const filters = {
    ...(minLevel ? { level: minLevel } : {}),
    ...(source ? { source } : {}),
    ...(query ? { q: query } : {}),
  }
  const filtered = Object.keys(filters).length > 0
  const oldest = entries.at(-1)

  return (
    <>
      <PageHeader
        title="Logs"
        description="What the web app and the worker have written to their logs, newest first. The same lines `docker logs` shows."
        actions={
          <>
            {/* Paging back through history and jumping to the top do not mix. */}
            {!before && <LiveRefresh />}
            <Button asChild variant="secondary" size="sm">
              <a href={`/api/admin/logs/download?${new URLSearchParams(filters)}`} download>
                <Download />
                Download
              </a>
            </Button>
          </>
        }
      />

      <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
        <div className="w-44">
          <Select name="level" defaultValue={minLevel ?? ''} aria-label="Level">
            <option value="">All levels</option>
            <option value="warn">Warnings and errors</option>
            <option value="error">Errors only</option>
          </Select>
        </div>
        <div className="w-44">
          <Select name="source" defaultValue={source ?? ''} aria-label="Process">
            <option value="">Web and worker</option>
            <option value="web">Web</option>
            <option value="worker">Worker</option>
          </Select>
        </div>
        <div className="min-w-48 flex-1">
          <Input
            name="q"
            type="search"
            defaultValue={query ?? ''}
            placeholder="Search log text, e.g. scan or a model name"
            aria-label="Search the logs"
          />
        </div>
        <Button type="submit" variant="secondary">
          Filter
        </Button>
        {(filtered || before) && (
          <Button asChild variant="ghost">
            <Link href="/admin/health/logs">{filtered ? 'Clear' : 'Back to latest'}</Link>
          </Button>
        )}
      </form>

      {entries.length === 0 ? (
        <EmptyState
          icon={<Terminal />}
          title={filtered || before ? 'Nothing matches' : 'No log lines yet'}
          description={
            filtered || before
              ? 'No log lines match this filter.'
              : 'Lines appear here a couple of seconds after they are written. If the worker stays silent, check that its container is running.'
          }
        />
      ) : (
        <Card className="overflow-x-auto py-2">
          <ol className="min-w-max font-mono text-xs leading-5">
            {entries.map((entry) => (
              <LogLine key={entry.id} entry={entry} />
            ))}
          </ol>
        </Card>
      )}

      {entries.length === PAGE_SIZE && oldest && (
        <div className="mt-4 flex justify-end">
          <Button asChild variant="secondary" size="sm">
            <Link
              href={
                `/admin/health/logs?${new URLSearchParams({ ...filters, before: String(oldest.id) })}` as Route
              }
            >
              Older
            </Link>
          </Button>
        </div>
      )}
    </>
  )
}

function LogLine({ entry }: { entry: LogEntry }) {
  const level = isLogLevel(entry.level) ? entry.level : 'info'
  return (
    <li className="flex gap-3 px-4 hover:bg-[var(--color-surface-2)]">
      <LocalTime
        value={entry.at.toISOString()}
        seconds
        className="shrink-0 text-[var(--color-ink-faint)]"
      />
      <span className={cn('w-10 shrink-0 font-semibold uppercase', LEVEL_CLASS[level])}>
        {level}
      </span>
      <span className="w-12 shrink-0 text-[var(--color-ink-faint)]">{entry.source}</span>
      <span className={cn('whitespace-pre-wrap', level === 'error' && LEVEL_CLASS.error)}>
        {entry.scope && <span className="text-[var(--color-accent)]">[{entry.scope}] </span>}
        {entry.message}
      </span>
    </li>
  )
}
