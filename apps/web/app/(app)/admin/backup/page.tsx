import { and, desc, eq } from 'drizzle-orm'
import { can } from '@pb/core'
import { getSessionUser } from '@pb/auth'
import { getDb, schema } from '@pb/db'
import { PageHeader } from '@/components/shell/page-header'
import { NotPermitted } from '@/components/shell/not-permitted'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { LocalTime } from '@/components/ui/local-time'
import { RestorePanel } from '@/components/backup/restore-panel'
import { createRestoreTicket } from './actions'
import { ExportPanel } from './export-panel'

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
  const [managed, lastExport] = await Promise.all([
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
  ])
  const last = lastExport[0]

  return (
    <>
      <PageHeader
        title="Backup"
        description="Download everything this instance knows as one file, or replace this instance with a backup from another."
      />

      <div className="max-w-2xl space-y-4">
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
