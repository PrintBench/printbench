import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { Boxes, HardDrive, Users, Wrench } from 'lucide-react'
import { can } from '@pm/core'
import { getSessionUser } from '@pm/auth'
import { getDb } from '@pm/db'
import { PageHeader } from '@/components/shell/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Button } from '@/components/ui/button'

export const dynamic = 'force-dynamic'

async function counts() {
  const result = await getDb().execute<{
    libraries: number
    models: number
    files: number
    users: number
  }>(sql`
    SELECT
      (SELECT count(*)::int FROM libraries)                              AS libraries,
      (SELECT count(*)::int FROM models WHERE missing_at IS NULL)        AS models,
      (SELECT count(*)::int FROM model_files WHERE missing_at IS NULL)   AS files,
      (SELECT count(*)::int FROM "user")                                 AS users
  `)
  return result.rows[0] ?? { libraries: 0, models: 0, files: 0, users: 0 }
}

const NUMBER = new Intl.NumberFormat('en-GB')

function Stat({
  label,
  value,
  icon: Icon,
}: {
  label: string
  value: number
  icon: React.ComponentType<{ className?: string }>
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <span className="flex size-9 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-surface-2)] text-[var(--color-ink-faint)]">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-xl font-semibold tabular-nums leading-tight">{NUMBER.format(value)}</p>
          <p className="truncate text-xs text-[var(--color-ink-muted)]">{label}</p>
        </div>
      </CardContent>
    </Card>
  )
}

export default async function DashboardPage() {
  const user = await getSessionUser()
  const stats = await counts()
  const policyUser = { id: user!.id, role: user!.role ?? 'viewer' }

  return (
    <>
      <PageHeader
        title={`Welcome, ${user!.name.split(' ')[0]}`}
        description="Your print library at a glance."
      />

      <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Libraries" value={stats.libraries} icon={HardDrive} />
        <Stat label="Models" value={stats.models} icon={Boxes} />
        <Stat label="Files" value={stats.files} icon={Wrench} />
        <Stat label="Users" value={stats.users} icon={Users} />
      </div>

      {stats.libraries === 0 ? (
        <EmptyState
          icon={<HardDrive />}
          title="No libraries yet"
          description={
            can(policyUser, 'library:manage')
              ? 'Point Print Manager at a folder of STL and 3MF files and it will index them in place — your files are never moved or renamed.'
              : 'An admin needs to add a library before anything appears here.'
          }
          action={
            can(policyUser, 'library:manage') ? (
              <Button disabled title="Arrives in phase 2">
                Add a library
              </Button>
            ) : undefined
          }
        />
      ) : (
        <EmptyState
          icon={<Boxes />}
          title="Nothing indexed yet"
          description="Run a scan to populate your library."
        />
      )}

      <p className="mt-8 text-xs text-[var(--color-ink-faint)]">
        Phase 1 of 8 — accounts and app shell. Libraries and scanning arrive next.{' '}
        <Link href="/admin/users" className="text-[var(--color-accent)] hover:underline">
          Manage users
        </Link>
      </p>
    </>
  )
}
