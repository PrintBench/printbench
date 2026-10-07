import type { Route } from 'next'
import Link from 'next/link'
import { debugReportToMarkdown, formatBytes, type DebugReport } from '@pb/core'
import { diagnosticsUser } from '@/lib/diagnostics'
import { buildDebugReport } from '@/lib/debug-report'
import { cn } from '@/lib/cn'
import { PageHeader } from '@/components/shell/page-header'
import { NotPermitted } from '@/components/shell/not-permitted'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { LocalTime } from '@/components/ui/local-time'
import { ShareReport } from './share-report'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Debug info' }

export default async function DebugPage() {
  if (!(await diagnosticsUser())) return <NotPermitted what="debug information" />

  const report = await buildDebugReport()
  const web = report.processes.find((process) => process.source === 'web')
  const worker = report.processes.find((process) => process.source === 'worker')
  const warnings = findWarnings(report)

  return (
    <>
      <PageHeader
        title="Debug info"
        description="A snapshot of how this instance is set up and running. Attach it to a bug report so we can help."
      />

      {warnings.length > 0 && (
        <ul className="mb-6 space-y-2">
          {warnings.map((warning) => (
            <li
              key={warning}
              className="rounded-[var(--radius-card)] border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-4 py-3 text-sm text-[var(--color-danger)]"
            >
              {warning}
            </li>
          ))}
        </ul>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Version" value={report.app.version} hint={report.app.commit?.slice(0, 12)} />
        <Tile
          label="Web"
          value={web?.alive ? 'Running' : 'Unknown'}
          hint={web ? `Node ${web.node ?? '?'} · ${web.rssMb ?? '?'} MB` : 'No heartbeat yet'}
        />
        <Tile
          label="Worker"
          value={worker ? (worker.alive ? 'Running' : 'Not responding') : 'Never seen'}
          hint={
            worker ? `v${worker.version ?? '?'} · ${worker.rssMb ?? '?'} MB` : 'No heartbeat yet'
          }
          bad={!worker?.alive}
        />
        <Tile
          label="Database"
          value={
            report.database ? `PostgreSQL ${report.database.version.split(' ')[0]}` : 'Unavailable'
          }
          hint={report.database ? formatBytes(report.database.sizeBytes) : undefined}
          bad={!report.database}
        />
      </div>

      <ShareReport
        markdown={debugReportToMarkdown(report)}
        markdownWithoutLogs={debugReportToMarkdown(report, { includeLogs: false })}
        json={JSON.stringify(report, null, 2)}
        logLines={report.recentErrors.length}
      />

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Section title="Processes">
          {report.processes.length === 0 ? (
            <p className="text-sm text-[var(--color-ink-muted)]">No heartbeats recorded yet.</p>
          ) : (
            <dl className="space-y-3 text-sm">
              {report.processes.map((process) => (
                <div key={process.source}>
                  <dt className="font-medium capitalize">{process.source}</dt>
                  <dd className="text-[var(--color-ink-muted)]">
                    v{process.version ?? '?'} · Node {process.node ?? '?'} · {process.platform}/
                    {process.arch} · up since <LocalTime value={process.startedAt} /> · last seen{' '}
                    <LocalTime value={process.seenAt} seconds />
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </Section>

        <Section title="Host">
          <Pairs
            rows={{
              Platform: `${report.host.platform}/${report.host.arch}${report.host.inContainer ? ' (Docker)' : ''}`,
              Kernel: report.host.osRelease,
              CPUs: report.host.cpus,
              Memory: `${report.host.totalMemMb.toLocaleString('en-GB')} MB, ${report.host.freeMemMb.toLocaleString('en-GB')} MB free`,
              'Time zone': report.host.timezone,
              ...(report.dataDir
                ? {
                    'Data volume': `${formatBytes(report.dataDir.freeBytes)} free of ${formatBytes(report.dataDir.totalBytes)}`,
                  }
                : {}),
            }}
          />
        </Section>

        <Section title="Database">
          {report.database ? (
            <Pairs
              rows={{
                PostgreSQL: report.database.version,
                Size: formatBytes(report.database.sizeBytes),
                'Migrations applied': report.database.migrationsApplied,
                Connections: report.database.connections,
                Extensions: report.database.extensions.join(', ') || 'none',
              }}
            />
          ) : (
            <p className="text-sm text-[var(--color-danger)]">
              {report.failures.database ?? 'Unavailable.'}
            </p>
          )}
        </Section>

        <Section title="Configuration">
          <Pairs rows={report.config} mono />
        </Section>

        <Section title="Contents">
          <Pairs
            rows={{
              Models: report.counts.models ?? 0,
              Files: `${(report.counts.files ?? 0).toLocaleString('en-GB')} (${formatBytes(report.counts.fileBytes ?? 0)})`,
              Creators: report.counts.creators ?? 0,
              Tags: report.counts.tags ?? 0,
              Prints: report.counts.prints ?? 0,
              Users: summarise(report.users),
              Thumbnails: summarise(report.derived.thumbnails),
              'Open health problems': summarise(report.problems),
            }}
          />
        </Section>

        <Section title="Job queues">
          {report.queues ? (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-[var(--color-ink-muted)]">
                <tr>
                  <th className="pb-1 font-medium">Queue</th>
                  <th className="pb-1 text-right font-medium">Queued</th>
                  <th className="pb-1 text-right font-medium">Active</th>
                  <th className="pb-1 text-right font-medium">Failed</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {report.queues.map((queue) => (
                  <tr key={queue.name}>
                    <td className="py-0.5 font-mono text-xs">{queue.name}</td>
                    <td className="text-right">{queue.queued}</td>
                    <td className="text-right">{queue.active}</td>
                    <td
                      className={cn('text-right', queue.failed > 0 && 'text-[var(--color-danger)]')}
                    >
                      {queue.failed}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-[var(--color-danger)]">
              {report.failures.queues ?? 'Unavailable.'}
            </p>
          )}
        </Section>
      </div>

      <Section title="Libraries" className="mt-4">
        {report.libraries.length === 0 ? (
          <p className="text-sm text-[var(--color-ink-muted)]">No libraries yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead className="text-left text-xs text-[var(--color-ink-muted)]">
                <tr>
                  <th className="pb-1 font-medium">#</th>
                  <th className="pb-1 font-medium">Type</th>
                  <th className="pb-1 font-medium">Grouping</th>
                  <th className="pb-1 text-right font-medium">Models</th>
                  <th className="pb-1 text-right font-medium">Missing</th>
                  <th className="pb-1 text-right font-medium">Files</th>
                  <th className="pb-1 pl-4 font-medium">Last scan</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {report.libraries.map((library, index) => (
                  <tr key={index}>
                    <td className="py-0.5">{index + 1}</td>
                    <td>
                      {library.kind} · {library.backend}
                    </td>
                    <td>{library.grouping}</td>
                    <td className="text-right">{library.models.toLocaleString('en-GB')}</td>
                    <td className="text-right">{library.missingModels.toLocaleString('en-GB')}</td>
                    <td className="text-right">{library.files.toLocaleString('en-GB')}</td>
                    <td className="pl-4">
                      {library.lastScan
                        ? `${library.lastScan.status}${library.lastScan.abortReason ? ` (${library.lastScan.abortReason})` : ''}`
                        : 'never'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-[var(--color-ink-faint)]">
          Libraries are numbered rather than named: names and paths are left out of the report.
        </p>
      </Section>

      {report.recentErrors.length > 0 && (
        <p className="mt-4 text-sm text-[var(--color-ink-muted)]">
          {report.recentErrors.length} recent warning{report.recentErrors.length === 1 ? '' : 's'}{' '}
          and errors are in the log.{' '}
          <Link
            href={'/admin/health/logs?level=warn' as Route}
            className="font-medium text-[var(--color-accent)] hover:underline"
          >
            Open the logs
          </Link>
        </p>
      )}
    </>
  )
}

/** The things worth saying out loud before anyone reads the tables. */
function findWarnings(report: DebugReport): string[] {
  const warnings: string[] = []
  const web = report.processes.find((process) => process.source === 'web')
  const worker = report.processes.find((process) => process.source === 'worker')

  if (!worker) {
    warnings.push(
      'The worker has never reported in. Scans, thumbnails and uploads will not run until its container is started.',
    )
  } else if (!worker.alive) {
    warnings.push(
      'The worker has stopped reporting in. Scans, thumbnails and uploads will not run until it is back.',
    )
  } else if (web?.version && worker.version && web.version !== worker.version) {
    warnings.push(
      `The web app is on ${web.version} but the worker is on ${worker.version}. Update both containers to the same version.`,
    )
  }

  const failed = Object.keys(report.failures)
  if (failed.length > 0) warnings.push(`Could not collect: ${failed.join(', ')}.`)
  return warnings
}

function summarise(record: Record<string, number>): string {
  const entries = Object.entries(record).filter(([, n]) => n > 0)
  return entries.length === 0
    ? 'none'
    : entries.map(([key, n]) => `${n.toLocaleString('en-GB')} ${key.replace(/_/g, ' ')}`).join(', ')
}

function Tile({
  label,
  value,
  hint,
  bad = false,
}: {
  label: string
  value: string
  hint?: string
  bad?: boolean
}) {
  return (
    <div
      className={cn(
        'rounded-[var(--radius-card)] border p-4',
        bad
          ? 'border-[var(--color-danger)] bg-[var(--color-danger-soft)] text-[var(--color-danger)]'
          : 'border-[var(--color-border)] bg-[var(--color-surface)]',
      )}
    >
      <span className="block text-xs opacity-80">{label}</span>
      <span className="mt-1 block text-lg font-semibold leading-tight">{value}</span>
      {hint && <span className="mt-0.5 block text-xs opacity-80">{hint}</span>}
    </div>
  )
}

function Section({
  title,
  className,
  children,
}: {
  title: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

function Pairs({
  rows,
  mono = false,
}: {
  rows: Record<string, string | number | boolean>
  mono?: boolean
}) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      {Object.entries(rows).map(([key, value]) => (
        <div key={key} className="contents">
          <dt
            className={cn('text-[var(--color-ink-muted)]', mono && 'font-mono text-xs leading-5')}
          >
            {key}
          </dt>
          <dd className={cn('min-w-0 break-words', mono && 'font-mono text-xs leading-5')}>
            {typeof value === 'number' ? value.toLocaleString('en-GB') : String(value)}
          </dd>
        </div>
      ))}
    </dl>
  )
}
