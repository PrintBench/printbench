import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { Boxes, HardDrive, History, Printer, Users, Wrench } from 'lucide-react'
import { can, printStats } from '@pm/core'
import { getSessionUser } from '@pm/auth'
import { getDb } from '@pm/db'
import { PageHeader } from '@/components/shell/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Button } from '@/components/ui/button'
import { ModelCard, formatDimensions } from '@/components/model/model-card'

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

type RecentModel = {
  public_id: string
  name: string
  path: string
  file_count: number
  total_size: string
  library_name: string
  thumb_file_id: string | null
  bbox_x: string | null
  bbox_y: string | null
  bbox_z: string | null
}

/** The newest models, with whichever of their files has a rendered thumbnail. */
async function recentModels(): Promise<RecentModel[]> {
  const result = await getDb().execute<RecentModel>(sql`
    SELECT m.public_id, m.name, m.path, m.file_count, m.total_size, l.name AS library_name,
           f.id AS thumb_file_id, f.bbox_x, f.bbox_y, f.bbox_z
    FROM models m
    JOIN libraries l ON l.id = m.library_id
    LEFT JOIN LATERAL (
      SELECT id, bbox_x, bbox_y, bbox_z FROM model_files
      WHERE model_id = m.id AND thumb_state = 'ok' AND missing_at IS NULL
      ORDER BY size DESC LIMIT 1
    ) f ON true
    WHERE m.missing_at IS NULL
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 8
  `)
  return result.rows
}

type RecentPrint = {
  public_id: string
  model_name: string
  status: string
  printer_name: string | null
  material: string | null
  started_at: string | null
  created_at: string
}

async function recentPrints(): Promise<RecentPrint[]> {
  const result = await getDb().execute<RecentPrint>(sql`
    SELECT m.public_id, m.name AS model_name, p.status, p.printer_name, p.material,
           p.started_at, p.created_at
    FROM print_runs p JOIN models m ON m.id = p.model_id
    ORDER BY coalesce(p.started_at, p.created_at) DESC, p.created_at DESC
    LIMIT 6
  `)
  return result.rows
}

const NUMBER = new Intl.NumberFormat('en-GB')

function Stat({
  label,
  value,
  icon: Icon,
  href,
}: {
  label: string
  value: string
  icon: React.ComponentType<{ className?: string }>
  href?: '/models' | '/prints' | '/admin/libraries' | '/admin/users'
}) {
  const body = (
    <CardContent className="flex items-center gap-3 p-4">
      <span className="flex size-9 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-surface-2)] text-[var(--color-ink-faint)]">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="text-xl font-semibold tabular-nums leading-tight">{value}</p>
        <p className="truncate text-xs text-[var(--color-ink-muted)]">{label}</p>
      </div>
    </CardContent>
  )

  return href ? (
    <Card className="transition-shadow hover:shadow-[var(--shadow-card)]">
      <Link href={href}>{body}</Link>
    </Card>
  ) : (
    <Card>{body}</Card>
  )
}

export default async function DashboardPage() {
  const user = await getSessionUser()
  /*
   * The layout redirects when there is no session, but Next renders layout and
   * page concurrently — so this runs anyway, and asserting a user here throws
   * before the redirect lands. Rendering nothing is the honest answer.
   */
  if (!user) return null

  const policyUser = { id: user.id, role: user.role ?? 'viewer' }
  const canManage = can(policyUser, 'library:manage')

  const [stats, prints, models, latestPrints] = await Promise.all([
    counts(),
    printStats(getDb()),
    recentModels(),
    recentPrints(),
  ])

  return (
    <>
      <PageHeader
        title={`Welcome, ${user.name.split(' ')[0]}`}
        description="Your print library at a glance."
      />

      <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Models" value={NUMBER.format(stats.models)} icon={Boxes} href="/models" />
        <Stat label="Files" value={NUMBER.format(stats.files)} icon={Wrench} />
        <Stat
          label={
            /*
             * Null, not zero, when nothing has settled: a print still running is
             * not a failed one, and a 0% badge on a new library reads as broken.
             */
            prints.successRate == null
              ? 'Prints logged'
              : `Prints logged · ${Math.round(prints.successRate * 100)}% success`
          }
          value={NUMBER.format(prints.total)}
          icon={History}
          href="/prints"
        />
        <Stat
          label="Libraries"
          value={NUMBER.format(stats.libraries)}
          icon={HardDrive}
          href={canManage ? '/admin/libraries' : undefined}
        />
      </div>

      {stats.libraries === 0 ? (
        <EmptyState
          icon={<HardDrive />}
          title="No libraries yet"
          description={
            canManage
              ? 'Point Print Manager at a folder of STL and 3MF files and it will index them in place — your files are never moved or renamed.'
              : 'An admin needs to add a library before anything appears here.'
          }
          action={
            canManage ? (
              <Button asChild>
                <Link href="/admin/libraries/new">Add a library</Link>
              </Button>
            ) : undefined
          }
        />
      ) : models.length === 0 ? (
        <EmptyState
          icon={<Boxes />}
          title="Nothing indexed yet"
          description="The library is there but empty. Run a scan to populate it."
          action={
            canManage ? (
              <Button asChild variant="secondary">
                <Link href="/admin/libraries">Go to libraries</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <section className="mb-8">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Recently added</h2>
            <Link href="/models" className="text-sm text-[var(--color-accent)] hover:underline">
              All models
            </Link>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {models.map((model) => (
              <ModelCard
                key={model.public_id}
                publicId={model.public_id}
                name={model.name}
                path={model.path}
                fileCount={model.file_count}
                totalSize={Number(model.total_size)}
                libraryName={model.library_name}
                thumbFileId={model.thumb_file_id}
                dimensions={formatDimensions(
                  Number(model.bbox_x ?? 0),
                  Number(model.bbox_y ?? 0),
                  Number(model.bbox_z ?? 0),
                )}
              />
            ))}
          </div>
        </section>
      )}

      {latestPrints.length > 0 && (
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Latest prints</h2>
            <Link href="/prints" className="text-sm text-[var(--color-accent)] hover:underline">
              Print history
            </Link>
          </div>

          <Card className="overflow-hidden">
            <ul className="divide-y divide-[var(--color-border)]">
              {latestPrints.map((print, index) => (
                <li key={`${print.public_id}-${index}`} className="flex items-center gap-3 px-4 py-2.5">
                  <Printer className="size-4 shrink-0 text-[var(--color-ink-faint)]" />
                  <Link
                    href={`/models/${print.public_id}`}
                    className="min-w-0 flex-1 truncate text-sm hover:underline"
                  >
                    {print.model_name}
                  </Link>
                  <span className="hidden shrink-0 text-xs text-[var(--color-ink-muted)] sm:inline">
                    {[print.printer_name, print.material].filter(Boolean).join(' · ')}
                  </span>
                  <span className="shrink-0 text-xs text-[var(--color-ink-faint)]">
                    {new Date(print.started_at ?? print.created_at).toLocaleDateString('en-GB', {
                      day: 'numeric',
                      month: 'short',
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}
    </>
  )
}
