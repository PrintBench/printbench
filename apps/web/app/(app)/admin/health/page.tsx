import { Stethoscope } from 'lucide-react'
import type { Route } from 'next'
import Link from 'next/link'
import {
  PROBLEM_META,
  can,
  listProblems,
  problemSummary,
  type ProblemKind,
  type ProblemSeverity,
} from '@pb/core'
import { getSessionUser } from '@pb/auth'
import { getDb, schema } from '@pb/db'
import { PageHeader } from '@/components/shell/page-header'
import { NotPermitted } from '@/components/shell/not-permitted'
import { EmptyState } from '@/components/ui/empty-state'
import { ProblemList } from './problem-list'
import { RecheckButton } from './recheck-button'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Library health' }

const PAGE_SIZE = 100

export default async function HealthPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; library?: string; ignored?: string }>
}) {
  const user = await getSessionUser()
  if (!can({ id: user?.id ?? '', role: user?.role ?? null }, 'library:manage')) {
    return <NotPermitted what="library health" />
  }

  const params = await searchParams
  const db = getDb()

  const kind = (
    Object.keys(PROBLEM_META).includes(params.kind ?? '') ? params.kind : undefined
  ) as ProblemKind | undefined
  const showIgnored = params.ignored === '1'

  const [summary, problems, libraries] = await Promise.all([
    problemSummary(db, params.library),
    listProblems(db, {
      kind,
      libraryId: params.library,
      includeIgnored: showIgnored,
      limit: PAGE_SIZE,
    }),
    db
      .select({ id: schema.libraries.id, name: schema.libraries.name })
      .from(schema.libraries)
      .orderBy(schema.libraries.name),
  ])

  const totals = summary.reduce(
    (acc, row) => {
      acc.open += row.open
      acc.ignored += row.ignored
      if (row.severity === 'danger') acc.danger += row.open
      return acc
    },
    { open: 0, ignored: 0, danger: 0 },
  )

  return (
    <>
      <PageHeader
        title="Library health"
        description={
          totals.open === 0
            ? 'Nothing needs attention.'
            : `${totals.open} thing${totals.open === 1 ? '' : 's'} worth looking at` +
              (totals.danger > 0 ? `, ${totals.danger} urgent` : '') +
              (totals.ignored > 0 ? ` · ${totals.ignored} ignored` : '')
        }
        actions={<RecheckButton />}
      />

      {/*
        * Ordered by severity, so a missing drive is the first thing on the page
        * and four hundred untagged models are the last.
        */}
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {summary
          .filter((row) => row.open > 0)
          .map((row) => (
            <Link
              key={row.kind}
              href={
                `/admin/health?kind=${row.kind}${params.library ? `&library=${params.library}` : ''}` as Route
              }
              aria-current={row.kind === kind ? 'page' : undefined}
              className={tileClass(row.severity, row.kind === kind)}
            >
              <span className="text-2xl font-semibold tabular-nums leading-none">{row.open}</span>
              <span className="mt-1 block text-sm font-medium">{PROBLEM_META[row.kind].label}</span>
              <span className="mt-0.5 block text-xs opacity-80">{PROBLEM_META[row.kind].hint}</span>
            </Link>
          ))}
      </div>

      <nav className="mb-4 flex flex-wrap items-center gap-1.5 text-sm">
        <FilterLink href={`/admin/health${params.library ? `?library=${params.library}` : ''}`} active={!kind}>
          All kinds
        </FilterLink>

        {libraries.length > 1 && (
          <>
            <span className="mx-1 text-[var(--color-ink-faint)]">·</span>
            <FilterLink href={`/admin/health${kind ? `?kind=${kind}` : ''}`} active={!params.library}>
              All libraries
            </FilterLink>
            {libraries.map((library) => (
              <FilterLink
                key={library.id}
                href={`/admin/health?library=${library.id}${kind ? `&kind=${kind}` : ''}`}
                active={params.library === library.id}
              >
                {library.name}
              </FilterLink>
            ))}
          </>
        )}

        <span className="mx-1 text-[var(--color-ink-faint)]">·</span>
        <FilterLink
          href={`/admin/health?${new URLSearchParams({
            ...(kind ? { kind } : {}),
            ...(params.library ? { library: params.library } : {}),
            ...(showIgnored ? {} : { ignored: '1' }),
          }).toString()}`}
          active={showIgnored}
        >
          {showIgnored ? 'Hiding nothing' : 'Show ignored'}
        </FilterLink>
      </nav>

      {problems.length === 0 ? (
        <EmptyState
          icon={<Stethoscope className="size-6" />}
          title={totals.open === 0 ? 'The library looks healthy' : 'Nothing here'}
          description={
            totals.open === 0
              ? 'No missing files, no duplicates, nothing unreadable. Health is re-examined after every scan and again overnight.'
              : 'Nothing matches this filter.'
          }
        />
      ) : (
        <ProblemList
          problems={problems.map((problem) => ({
            id: problem.id,
            kind: problem.kind,
            severity: problem.severity,
            modelName: problem.modelName,
            modelPublicId: problem.modelPublicId,
            filename: problem.filename,
            libraryName: problem.libraryName,
            detail: problem.detail,
            ignored: problem.ignoredAt != null,
          }))}
          truncated={problems.length === PAGE_SIZE}
          kind={kind}
        />
      )}
    </>
  )
}

function FilterLink({
  href,
  active,
  children,
}: {
  href: string
  active: boolean
  children: React.ReactNode
}) {
  return (
    <Link
      href={href as Route}
      aria-current={active ? 'page' : undefined}
      className={
        active
          ? 'rounded-full bg-[var(--color-accent-soft)] px-3 py-1 font-medium text-[var(--color-accent)]'
          : 'rounded-full px-3 py-1 text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-2)]'
      }
    >
      {children}
    </Link>
  )
}

function tileClass(severity: ProblemSeverity, active: boolean): string {
  const base =
    'block rounded-[var(--radius-card)] border p-4 transition-shadow hover:shadow-[var(--shadow-card)]'
  const ring = active ? ' ring-2 ring-[var(--color-accent)]' : ''

  switch (severity) {
    case 'danger':
      return `${base}${ring} border-[var(--color-danger)] bg-[var(--color-danger-soft)] text-[var(--color-danger)]`
    case 'warning':
      return `${base}${ring} border-[var(--color-warning)] text-[var(--color-ink)]`
    default:
      return `${base}${ring} border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-ink)]`
  }
}
