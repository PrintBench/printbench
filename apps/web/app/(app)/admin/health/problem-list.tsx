'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { AlertTriangle, EyeOff, Info, Loader2, OctagonAlert, RotateCcw, Check } from 'lucide-react'
import { PROBLEM_META, type ProblemKind, type ProblemSeverity } from '@pm/core/health'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ignore, ignoreWholeKind, resolve, unignore } from './actions'

/**
 * The problem list, with bulk triage.
 *
 * Bulk is the point. A library that has never been curated raises hundreds of
 * "no licence" entries, and a list you can only act on one row at a time is a
 * list nobody finishes.
 */

export interface ProblemView {
  id: string
  kind: ProblemKind
  severity: ProblemSeverity
  modelName: string | null
  modelPublicId: string | null
  filename: string | null
  libraryName: string | null
  detail: unknown
  ignored: boolean
}

const SEVERITY_ICON = {
  danger: OctagonAlert,
  warning: AlertTriangle,
  info: Info,
} as const

const SEVERITY_CLASS = {
  danger: 'text-[var(--color-danger)]',
  warning: 'text-[var(--color-warning)]',
  info: 'text-[var(--color-ink-faint)]',
} as const

export function ProblemList({
  problems,
  truncated,
  kind,
}: {
  problems: ProblemView[]
  truncated: boolean
  kind?: ProblemKind
}) {
  const router = useRouter()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const allSelected = problems.length > 0 && selected.size === problems.length

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function run(action: (ids: string[]) => Promise<{ ok: boolean; error?: string }>) {
    const ids = [...selected]
    if (ids.length === 0) return
    setError(null)
    startTransition(async () => {
      const result = await action(ids)
      if (!result.ok) setError(result.error ?? 'That did not work.')
      else {
        setSelected(new Set())
        router.refresh()
      }
    })
  }

  function dismissKind() {
    if (!kind) return
    if (!confirm(`Ignore every open "${PROBLEM_META[kind].label}" problem? You can undo this.`)) {
      return
    }
    startTransition(async () => {
      const result = await ignoreWholeKind(kind)
      if (!result.ok) setError(result.error ?? 'That did not work.')
      else router.refresh()
    })
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm text-[var(--color-ink-muted)]">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={() =>
              setSelected(allSelected ? new Set() : new Set(problems.map((p) => p.id)))
            }
          />
          {selected.size > 0 ? `${selected.size} selected` : 'Select all'}
        </label>

        {selected.size > 0 && (
          <>
            <Button variant="secondary" size="sm" disabled={pending} onClick={() => run(ignore)}>
              {pending ? <Loader2 className="animate-spin" /> : <EyeOff />}
              Ignore
            </Button>
            <Button variant="secondary" size="sm" disabled={pending} onClick={() => run(unignore)}>
              <RotateCcw />
              Un-ignore
            </Button>
            {/*
              * Resolving by hand is rarely right — detectors clear their own —
              * so it sits behind the less prominent styling.
              */}
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(resolve)}>
              <Check />
              Mark fixed
            </Button>
          </>
        )}

        {kind && selected.size === 0 && (
          <Button variant="ghost" size="sm" disabled={pending} onClick={dismissKind}>
            <EyeOff />
            Ignore all {PROBLEM_META[kind].label.toLowerCase()}
          </Button>
        )}
      </div>

      {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}

      <Card className="overflow-hidden">
        <ul className="divide-y divide-[var(--color-border)]">
          {problems.map((problem) => {
            const Icon = SEVERITY_ICON[problem.severity]
            return (
              <li
                key={problem.id}
                className={`flex items-start gap-3 px-4 py-2.5 ${problem.ignored ? 'opacity-55' : ''}`}
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={selected.has(problem.id)}
                  onChange={() => toggle(problem.id)}
                  aria-label={`Select ${problem.modelName ?? 'problem'}`}
                />
                <Icon className={`mt-0.5 size-4 shrink-0 ${SEVERITY_CLASS[problem.severity]}`} />

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 text-sm">
                    {problem.modelPublicId ? (
                      <Link
                        href={`/models/${problem.modelPublicId}`}
                        className="truncate font-medium hover:underline"
                      >
                        {problem.modelName}
                      </Link>
                    ) : (
                      <span className="font-medium">{problem.modelName ?? 'Library'}</span>
                    )}
                    <span className="text-xs text-[var(--color-ink-muted)]">
                      {PROBLEM_META[problem.kind].label}
                    </span>
                    {problem.ignored && (
                      <span className="text-xs text-[var(--color-ink-faint)]">ignored</span>
                    )}
                  </div>

                  {(problem.filename || problem.libraryName) && (
                    <p className="truncate text-xs text-[var(--color-ink-faint)]">
                      {[problem.libraryName, problem.filename].filter(Boolean).join(' · ')}
                    </p>
                  )}
                  <Detail kind={problem.kind} detail={problem.detail} />
                </div>
              </li>
            )
          })}
        </ul>
      </Card>

      {truncated && (
        <p className="text-xs text-[var(--color-ink-faint)]">
          Showing the first 100. Act on these and the next batch appears.
        </p>
      )}
    </div>
  )
}

/** The kind-specific bit worth reading — what else shares the bytes, which folder. */
function Detail({ kind, detail }: { kind: ProblemKind; detail: unknown }) {
  if (!detail || typeof detail !== 'object') return null
  const data = detail as Record<string, unknown>

  if (kind === 'duplicate_digest' && typeof data.copies === 'number') {
    return (
      <p className="text-xs text-[var(--color-ink-muted)]">
        {data.copies} copies of these bytes across the library
      </p>
    )
  }
  if (kind === 'nested_model' && typeof data.parentPath === 'string') {
    return (
      <p className="truncate font-mono text-xs text-[var(--color-ink-muted)]">
        inside {data.parentPath}
      </p>
    )
  }
  if (kind === 'unparseable') {
    return (
      <p className="text-xs text-[var(--color-ink-muted)]">
        {/* The parser's own explanation when there is one; the raw states
            otherwise, for a failure recorded before reasons were kept. */}
        {typeof data.reason === 'string' && data.reason
          ? data.reason
          : `analysis ${String(data.analysis)}, thumbnail ${String(data.thumbnail)}`}
      </p>
    )
  }
  return null
}
