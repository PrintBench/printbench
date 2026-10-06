'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Check, CircleAlert, LoaderCircle, X } from 'lucide-react'
import type { Activity } from '@/lib/activity'
import { reconcileActivity, SUCCESS_HOLD_MS, type ActivityRow } from './activity-state'
import { cn } from '@/lib/cn'

export function ActivityPanel() {
  const pathname = usePathname()
  const [rows, setRows] = useState<ActivityRow[]>([])
  const [stale, setStale] = useState(false)
  const [now, setNow] = useState(0)
  const startedAt = useRef(0)
  const dismissed = useRef(new Set<string>())
  const trackedIds = useRef<string[]>([])

  useEffect(() => {
    trackedIds.current = rows
      .filter(
        (row) => row.kind !== 'processing' && (row.state === 'running' || row.state === 'queued'),
      )
      .map((row) => row.id)
      .slice(0, 1000)
  }, [rows])

  useEffect(() => {
    startedAt.current ||= Date.now()
    let stopped = false
    let fetching = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    async function refresh() {
      if (stopped || fetching || document.visibilityState === 'hidden') return
      clearTimeout(timer)
      fetching = true
      let busy = false
      try {
        const query = new URLSearchParams(trackedIds.current.map((id) => ['id', id]))
        const response = await fetch(`/api/activity?${query}`, {
          cache: 'no-store',
          signal: controller.signal,
        })
        if (response.status === 401 || response.status === 403) {
          stopped = true
          setRows([])
          return
        }
        if (!response.ok) throw new Error('Activity unavailable')
        const { activities } = (await response.json()) as { activities: Activity[] }
        if (stopped) return
        busy = activities.some(
          (activity) => activity.state === 'running' || activity.state === 'queued',
        )
        const time = Date.now()
        setNow(time)
        setRows((current) =>
          reconcileActivity(current, activities, dismissed.current, startedAt.current, time),
        )
        setStale(false)
      } catch {
        if (!stopped) setStale(true)
      } finally {
        fetching = false
        if (!stopped) timer = setTimeout(() => void refresh(), busy ? 3000 : 10000)
      }
    }
    const wake = () => void refresh()
    wake()
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('focus', wake)
    return () => {
      stopped = true
      controller.abort()
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('focus', wake)
    }
  }, [pathname])

  const hasCompleted = rows.some((row) => row.finishedAt !== undefined)
  useEffect(() => {
    if (!hasCompleted) return
    const timer = setInterval(() => {
      const time = Date.now()
      setNow(time)
      setRows((current) =>
        reconcileActivity(current, [], dismissed.current, startedAt.current, time),
      )
    }, 100)
    return () => clearInterval(timer)
  }, [hasCompleted])

  if (!rows.length) return null
  return (
    <aside
      aria-label="Background activity"
      className="fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] left-4 z-40 sm:left-auto sm:w-80"
    >
      <div
        className="max-h-[45dvh] space-y-2 overflow-y-auto p-1"
        role="status"
        aria-live="polite"
        aria-atomic="false"
      >
        {rows.map((row) => {
          const failed = row.state === 'failed'
          const complete = row.state === 'completed'
          const leaving = row.finishedAt !== undefined && now >= row.finishedAt + SUCCESS_HOLD_MS
          return (
            <div
              key={row.id}
              className={cn(
                'activity-enter flex items-center gap-3 rounded-card border border-border bg-surface p-3 text-sm shadow-pop',
                leaving && 'activity-exit',
              )}
            >
              {failed ? (
                <CircleAlert className="h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
              ) : complete ? (
                <Check className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
              ) : (
                <LoaderCircle
                  className="h-4 w-4 shrink-0 animate-spin text-accent motion-reduce:animate-none"
                  aria-hidden="true"
                />
              )}
              <Link
                href={row.href}
                className="min-w-0 flex-1 rounded-control text-ink hover:underline focus-visible:outline-2 focus-visible:outline-accent"
              >
                {row.label}
              </Link>
              {(failed || complete) && (
                <button
                  type="button"
                  aria-label={`Dismiss: ${row.label}`}
                  className="rounded-control p-1 text-ink-muted hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
                  onClick={() => {
                    dismissed.current.add(row.id)
                    setRows((current) => current.filter((item) => item.id !== row.id))
                  }}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </div>
          )
        })}
      </div>
      {stale && (
        <p
          className="mt-2 rounded-control bg-surface px-3 py-2 text-xs text-ink-muted"
          role="status"
        >
          Activity updates interrupted. Reconnecting…
        </p>
      )}
    </aside>
  )
}
