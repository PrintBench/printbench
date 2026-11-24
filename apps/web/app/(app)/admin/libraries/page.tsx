import Link from 'next/link'
import { desc, eq, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { Cloud, FolderPlus, HardDrive, Loader2, Lock, Pencil, Upload } from 'lucide-react'
import { getSessionUser } from '@pb/auth'
import { can, libraryLocationLabel, listExclusions, nextRun } from '@pb/core'
import { getDb, schema } from '@pb/db'
import { PageHeader } from '@/components/shell/page-header'
import { NotPermitted } from '@/components/shell/not-permitted'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ScanButton } from './scan-button'
import { SchedulePicker } from './schedule-picker'
import { RemovedModels } from './removed-models'
import { DeleteLibraryButton } from './delete-library-button'

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

  // The library a `move` removal is sending models into, by name.
  const removalDestination = alias(schema.libraries, 'removal_destination')

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
      writeSidecar: schema.libraries.writeSidecar,
      s3Prefix: schema.libraries.s3Prefix,
      s3ConnectionName: schema.s3Connections.name,
      s3Bucket: schema.s3Connections.bucket,
      s3Endpoint: schema.s3Connections.endpoint,
      removalMode: schema.libraries.removalMode,
      removalError: schema.libraries.removalError,
      removalDestinationName: removalDestination.name,
      createdAt: schema.libraries.createdAt,
    })
    .from(schema.libraries)
    .leftJoin(schema.s3Connections, eq(schema.s3Connections.id, schema.libraries.s3ConnectionId))
    .leftJoin(removalDestination, eq(removalDestination.id, schema.libraries.removalDestinationId))
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
        description="Folders PrintBench indexes. Your files are never moved or renamed."
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
          description="Point PrintBench at a folder of STL and 3MF files. It indexes them where they already live. Nothing is moved, renamed or deleted."
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
            /*
             * One icon and one phrase for where the files are and what the
             * library is for, because a path or a bucket name alone does not
             * say whether PrintBench writes there or whose service it is.
             */
            const LocationIcon =
              library.backend === 's3' ? Cloud : library.kind === 'managed' ? Upload : HardDrive
            const location = libraryLocationLabel({
              backend: library.backend,
              kind: library.kind,
              s3Endpoint: library.s3Endpoint,
              hasS3Connection: library.s3Bucket !== null,
            })

            return (
              <Card key={library.id}>
                <CardContent className="flex flex-wrap items-start gap-4 p-5">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-surface-2)] text-[var(--color-ink-faint)]">
                    <LocationIcon className="size-5" />
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-semibold">{library.name}</h2>
                      <Badge
                        tone={library.backend === 's3' && !library.s3Bucket ? 'danger' : 'accent'}
                      >
                        <LocationIcon className="size-3" />
                        {location}
                      </Badge>
                      {library.kind === 'in_place' && (
                        <Badge tone="neutral">
                          <Lock className="size-3" />
                          Read-only
                        </Badge>
                      )}
                      {!library.scanEnabled && <Badge tone="neutral">Scanning off</Badge>}
                    </div>

                    <p className="mt-0.5 truncate font-mono text-xs text-[var(--color-ink-faint)]">
                      {library.backend === 's3'
                        ? library.s3Bucket
                          ? `s3://${library.s3Bucket}/${library.s3Prefix ? `${library.s3Prefix.replace(/^\/+|\/+$/g, '')}/` : ''} · ${library.s3ConnectionName}`
                          : 'No S3 connection. Edit the library to choose one.'
                        : library.path}
                    </p>

                    <p className="mt-2 text-sm text-[var(--color-ink-muted)]">
                      {/*
                        A count is the obvious thing to click when you want to
                        see what it counted. Search already filters by library,
                        so this needs no new page — just the link nobody had
                        put on it.
                      */}
                      {(stat?.models ?? 0) > 0 ? (
                        <Link
                          href={`/search?library=${library.id}`}
                          className="font-medium text-[var(--color-ink)] underline decoration-[var(--color-border-strong)] underline-offset-2 hover:decoration-[var(--color-accent)]"
                        >
                          {NUMBER.format(stat!.models)} models
                        </Link>
                      ) : (
                        <>0 models</>
                      )}{' '}
                      · {NUMBER.format(stat?.files ?? 0)} files ·{' '}
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

                    {library.removalError && (
                      <p role="alert" className="mt-2 text-sm text-[var(--color-danger)]">
                        {library.removalError}
                      </p>
                    )}

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
                            Last scan was stopped for safety ({run.abort_reason?.replace(/_/g, ' ')}
                            ). Nothing was removed from the index.
                          </>
                        ) : (
                          <>
                            Last {run.mode} scan{' '}
                            {run.finished_at
                              ? DATE.format(new Date(run.finished_at))
                              : 'in progress'}
                            {run.models_created > 0 && ` · ${run.models_created} added`}
                            {run.models_missing > 0 && ` · ${run.models_missing} missing`}
                          </>
                        )}
                      </p>
                    )}
                  </div>

                  {library.removalMode ? (
                    /*
                     * The worker is deleting or moving everything; scanning,
                     * editing or removing it again meanwhile would only race
                     * that. The model count above falls as models move out.
                     */
                    <p className="flex max-w-56 items-start gap-2 text-sm text-[var(--color-ink-muted)]">
                      <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />
                      {library.removalMode === 'delete_files'
                        ? 'Deleting its files, then removing it.'
                        : `Moving its models into ${library.removalDestinationName ?? 'another library'}, then removing it.`}
                    </p>
                  ) : (
                    <div className="flex flex-col items-end gap-1.5">
                      <ScanButton libraryId={library.id} needsConfirmation={aborted} />
                      <Button variant="ghost" size="sm" asChild>
                        <Link href={`/admin/libraries/${library.id}`}>
                          <Pencil />
                          Edit
                        </Link>
                      </Button>
                      <DeleteLibraryButton
                        libraryId={library.id}
                        name={library.name}
                        modelCount={stat?.models ?? 0}
                        writesSidecars={library.writeSidecar}
                      />
                    </div>
                  )}
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
