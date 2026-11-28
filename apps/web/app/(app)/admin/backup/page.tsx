import { and, asc, desc, eq } from 'drizzle-orm'
import {
  BACKUP_KEEP_DEFAULT,
  BACKUP_PASSPHRASE_MIN_LENGTH,
  BACKUP_PREFIX_DEFAULT,
  BACKUP_SCHEDULE_PRESETS,
  backupLocation,
  can,
  describeBackupCron,
  describeS3Error,
  getBackupSchedule,
  getInstanceId,
  listBackupRuns,
  listBucketBackups,
  type BackupRunSummary,
} from '@pb/core'
import { getSessionUser } from '@pb/auth'
import { getDb, schema } from '@pb/db'
import { PageHeader } from '@/components/shell/page-header'
import { NotPermitted } from '@/components/shell/not-permitted'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { LocalTime } from '@/components/ui/local-time'
import { RestorePanel } from '@/components/backup/restore-panel'
import { Badge } from '@/components/ui/badge'
import { createRestoreTicket } from './actions'
import { BucketList, type BucketRow } from './bucket-list'
import { ExportPanel } from './export-panel'
import { ScheduleForm } from './schedule-form'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Backup' }

export default async function BackupPage() {
  const user = await getSessionUser()
  if (
    !can(
      { id: user?.id ?? '', role: user?.role ?? null, banned: user?.banned ?? false },
      'instance:backup',
    )
  ) {
    return <NotPermitted what="backups" />
  }

  const db = getDb()
  const [managed, lastExport, schedule, runs, connections] = await Promise.all([
    db
      .select({ id: schema.libraries.id })
      .from(schema.libraries)
      .where(and(eq(schema.libraries.kind, 'managed'), eq(schema.libraries.backend, 'local'))),
    db
      .select({ at: schema.auditEvents.occurredAt, by: schema.auditEvents.actorName })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, 'backup.exported'))
      .orderBy(desc(schema.auditEvents.occurredAt))
      .limit(1),
    getBackupSchedule(db),
    listBackupRuns(db, 5),
    db
      .select({
        id: schema.s3Connections.id,
        name: schema.s3Connections.name,
        bucket: schema.s3Connections.bucket,
      })
      .from(schema.s3Connections)
      .orderBy(asc(schema.s3Connections.name)),
  ])
  const last = lastExport[0]
  const bucket = schedule ? await readBucket() : null
  const instanceId = schedule ? await getInstanceId(db) : ''

  return (
    <>
      <PageHeader
        title="Backup"
        description="Back up to S3 on a schedule, download everything this instance knows as one file, or replace this instance with a backup."
      />

      <div className="max-w-2xl space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Scheduled backups</CardTitle>
            <CardDescription>
              Encrypted backups of accounts, settings, model records and photos, written to one of
              your S3 buckets. Library files are left out: they are already where they live.
              {schedule?.nextRunAt && schedule.enabled && (
                <>
                  {' '}
                  {describeBackupCron(schedule.cron)}; next at{' '}
                  <LocalTime value={schedule.nextRunAt.toISOString()} />.
                </>
              )}
              {schedule && !schedule.enabled && ' Paused.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ScheduleForm
              existing={
                schedule && {
                  enabled: schedule.enabled,
                  s3ConnectionId: schedule.s3ConnectionId,
                  prefix: schedule.prefix,
                  cron: schedule.cron,
                  keep: schedule.keep,
                  keyId: schedule.keyId,
                }
              }
              connections={connections}
              presets={BACKUP_SCHEDULE_PRESETS}
              defaults={{
                prefix: BACKUP_PREFIX_DEFAULT,
                keep: BACKUP_KEEP_DEFAULT,
                minPassphrase: BACKUP_PASSPHRASE_MIN_LENGTH,
              }}
            />
            {runs.length > 0 && <RecentRuns runs={runs} />}
          </CardContent>
        </Card>

        {schedule && bucket && (
          <Card>
            <CardHeader>
              <CardTitle>Backups in the bucket</CardTitle>
              <CardDescription>
                This instance writes to {schedule.bucket}/{schedule.prefix}/{instanceId}, a folder
                of its own. Restoring a backup needs the passphrase it was taken with.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {bucket.ok ? (
                <BucketList
                  rows={bucket.rows}
                  currentKeyId={schedule.keyId}
                  instanceId={instanceId}
                />
              ) : (
                <p role="alert" className="text-sm text-[var(--color-danger)]">
                  Could not list the bucket: {bucket.error}
                </p>
              )}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Download a backup</CardTitle>
            <CardDescription>
              Accounts, libraries, models, tags, collections, print history, printers, settings and
              the audit trail. Thumbnails are left out and re-rendered after a restore.{' '}
              {last ? (
                <>
                  Last downloaded <LocalTime value={last.at.toISOString()} />
                  {last.by ? ` by ${last.by}` : ''}.
                </>
              ) : (
                'No backup has been downloaded yet.'
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ExportPanel managedLibraries={managed.length} />
            <p className="mt-4 text-xs text-[var(--color-ink-faint)]">
              The file holds email addresses and password hashes. Store it as carefully as you would
              the database itself.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Restore from a backup</CardTitle>
            <CardDescription>
              Makes this instance a copy of the one the backup came from. To move to a new server,
              restore from its first-run screen instead and there is nothing to replace.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RestorePanel getTicket={createRestoreTicket} />
          </CardContent>
        </Card>
      </div>
    </>
  )
}

/**
 * Lists the bucket for the page. A few small reads: the listing, and a range
 * read of each backup's plaintext header. Failure is shown, not thrown — an
 * unreachable bucket is exactly when an admin needs this page to load.
 */
async function readBucket(): Promise<
  { ok: true; rows: BucketRow[] } | { ok: false; error: string }
> {
  const location = await backupLocation(getDb())
  if (!location.ok) return location
  try {
    const backups = await listBucketBackups(location.data)
    return {
      ok: true,
      rows: backups.map((backup) => ({
        path: backup.path,
        instanceId: backup.instanceId,
        name: backup.name,
        bytes: backup.bytes,
        createdAt: backup.header?.createdAt ?? null,
        appVersion: backup.header?.appVersion ?? null,
        keyId: backup.header?.keyId ?? null,
        problem: backup.problem,
      })),
    }
  } catch (error) {
    return { ok: false, error: describeS3Error(error, location.data.s3Bucket ?? '') }
  }
}

function RecentRuns({ runs }: { runs: BackupRunSummary[] }) {
  return (
    <div className="mt-6 border-t border-[var(--color-border)] pt-4">
      <h3 className="mb-2 text-sm font-medium">Recent runs</h3>
      <ul className="space-y-1.5 text-sm">
        {runs.map((run) => (
          <li key={run.id} className="flex flex-wrap items-baseline gap-2">
            <Badge
              tone={
                run.status === 'failed' ? 'danger' : run.status === 'running' ? 'accent' : 'neutral'
              }
            >
              {run.status === 'succeeded' ? 'Done' : run.status === 'failed' ? 'Failed' : 'Running'}
            </Badge>
            <LocalTime value={run.startedAt.toISOString()} />
            <span className="text-[var(--color-ink-faint)]">
              {run.trigger === 'manual' ? `by ${run.requestedBy ?? 'an admin'}` : 'scheduled'}
              {run.pruned > 0 ? ` · removed ${run.pruned} older` : ''}
            </span>
            {run.error && <span className="w-full text-[var(--color-danger)]">{run.error}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}
