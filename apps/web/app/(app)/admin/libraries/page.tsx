import Link from 'next/link'
import { desc, sql } from 'drizzle-orm'
import { FolderPlus, HardDrive, Lock } from 'lucide-react'
import { getSessionUser } from '@pm/auth'
import { can, listExclusions, nextRun } from '@pm/core'
import { getDb, schema } from '@pm/db'
import { PageHeader } from '@/components/shell/page-header'
import { NotPermitted } from '@/components/shell/not-permitted'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ScanButton } from './scan-button'
import { SchedulePicker } from './schedule-picker'
import { RemovedModels } from './removed-models'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Libraries' }

const NUMBER = new Intl.NumberFormat('en-GB')
const DATE = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' })

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

export default async function LibrariesPage() {
  const user = await getSessionUser()
  if (!can({ id: user?.id ?? '', role: user?.role ?? null }, 'library:manage')) {
    return <NotPermitted what="library management" />
  }

  const db = getDb()

  const removed = await listExclusions(db)

  const libraries = await db
    .select({
      id: schema.libraries.id,
      name: schema.libraries.name,
      path: schema.libraries.path,
      kind: schema.libraries.kind,
      backend: schema.libraries.backend,
      groupingMode: schema.libraries.groupingMode,
      scanEnabled: schema.libraries.scanEnabled,
      scanCron: schema.libraries.scanCron,
      watchEnabled: schema.libraries.watchEnabled,
      createdAt: schema.libraries.createdAt,
    })
    .from(schema.libraries)
    .orderBy(desc(schema.libraries.createdAt))

  // One aggregate for all libraries rather than a query per row.
  const stats = await db.execute<{
    library_id: string
    models: number
    files: number
    total_size: string
  }>(sql`
    SELECT library_id,
           count(*)::int AS models,
           coalesce(sum(file_count), 0)::int AS files,
           coalesce(sum(total_size), 0)::bigint AS total_size
    FROM models WHERE missing_at IS NULL
    GROUP BY library_id
  `)
  const statsById = new Map(stats.rows.map((row) => [row.library_id, row]))

  const runs = await db.execute<{
    library_id: string
    status: string
    mode: string
    abort_reason: string | null
    finished_at: string | null
    models_created: number
    models_missing: number
  }>(sql`
    SELECT DISTINCT ON (library_id)
      library_id, status, mode, abort_reason, finished_at, models_created, models_missing
    FROM scan_runs ORDER BY library_id, created_at DESC
  `)
  const runById = new Map(runs.rows.map((row) => [row.library_id, row]))

  return (
    <>
      <PageHeader
        title="Libraries"
        description="Folders Print Manager indexes. Your files are never moved or renamed."
        actions={
          <Button asChild>
            <Link href="/admin/libraries/new">
              <FolderPlus />
              Add library
            </Link>
          </Button>
        }
      />

      {libraries.length === 0 ? (
        <EmptyState
          icon={<HardDrive />}
          title="No libraries yet"
          description="Point Print Manager at a folder of STL and 3MF files. It indexes them where they already live — nothing is moved, renamed or deleted."
          action={
            <Button asChild>
              <Link href="/admin/libraries/new">
                <FolderPlus />
                Add your first library
              </Link>
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {libraries.map((library) => {
            const stat = statsById.get(library.id)
            const run = runById.get(library.id)
            const aborted = run?.status === 'aborted'

            return (
              <Card key={library.id}>
                <CardContent className="flex flex-wrap items-start gap-4 p-5">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-surface-2)] text-[var(--color-ink-faint)]">
                    <HardDrive className="size-5" />
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-semibold">{library.name}</h2>
                      {library.kind === 'in_place' && (
                        <Badge tone="neutral">
                          <Lock className="size-3" />
                          Read-only
                        </Badge>
                      )}
                      {!library.scanEnabled && <Badge tone="neutral">Scanning off</Badge>}
                    </div>

                    <p className="mt-0.5 truncate font-mono text-xs text-[var(--color-ink-faint)]">
                      {library.path}
                    </p>

                    <p className="mt-2 text-sm text-[var(--color-ink-muted)]">
                      {NUMBER.format(stat?.models ?? 0)} models ·{' '}
                      {NUMBER.format(stat?.files ?? 0)} files ·{' '}
                      {formatBytes(Number(stat?.total_size ?? 0))}
                    </p>

                    <div className="mt-2">
                      <SchedulePicker
                        libraryId={library.id}
                        cron={library.scanCron ?? ''}
                        enabled={library.scanEnabled}
                        watchable={library.backend === 'local'}
                        watching={library.watchEnabled}
                        nextRunLabel={
                          /*
                           * Formatted on the server so the label and the
                           * schedule agree about the timezone — cron is read in
                           * the server's local time, not the browser's.
                           */
                          library.scanEnabled
                            ? (nextRun(library.scanCron)?.toLocaleString('en-GB', {
                                weekday: 'short',
                                hour: '2-digit',
                                minute: '2-digit',
                              }) ?? null)
                            : null
                        }
                      />
                    </div>

                    {run && (
                      <p
                        className={
                          aborted
                            ? 'mt-2 text-sm text-[var(--color-danger)]'
                            : 'mt-2 text-xs text-[var(--color-ink-faint)]'
                        }
                      >
                        {aborted ? (
                          <>
                            Last scan was stopped for safety ({run.abort_reason?.replace(/_/g, ' ')}).
                            Nothing was removed from the index.
                          </>
                        ) : (
                          <>
                            Last {run.mode} scan{' '}
                            {run.finished_at ? DATE.format(new Date(run.finished_at)) : 'in progress'}
                            {run.models_created > 0 && ` · ${run.models_created} added`}
                            {run.models_missing > 0 && ` · ${run.models_missing} missing`}
                          </>
                        )}
                      </p>
                    )}
                  </div>

                  <ScanButton libraryId={library.id} needsConfirmation={aborted} />
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      <RemovedModels
        removed={removed.map((entry) => ({
          libraryId: entry.libraryId,
          libraryName: entry.libraryName,
          path: entry.path,
          name: entry.name,
          excludedAt: entry.excludedAt.toISOString(),
        }))}
      />
    </>
  )
}
