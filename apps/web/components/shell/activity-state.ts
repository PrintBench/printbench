import type { Activity } from '../../lib/activity'

export interface ActivityRow extends Activity {
  finishedAt?: number
  failureBaseline?: number
}

export const SUCCESS_HOLD_MS = 4000
export const EXIT_MS = 300

/** An absent task or a failed request is never evidence of successful work. */
export function reconcileActivity(
  current: ActivityRow[],
  incoming: Activity[],
  dismissed: Set<string>,
  startedAt: number,
  now: number,
): ActivityRow[] {
  const rows = new Map(current.map((row) => [row.id, row]))
  for (const activity of incoming) {
    const previous = rows.get(activity.id)
    const active = activity.state === 'running' || activity.state === 'queued'
    if (active) {
      dismissed.delete(activity.id)
      rows.set(activity.id, {
        ...activity,
        failureBaseline:
          previous && (previous.state === 'running' || previous.state === 'queued')
            ? previous.failureBaseline
            : activity.failures,
      })
      continue
    }
    if (dismissed.has(activity.id)) continue
    // The aggregate exists even when idle. Only announce its observed work.
    if (activity.kind === 'processing') {
      if (!previous || previous.state === 'completed' || previous.state === 'failed') continue
      if ((activity.failures ?? 0) > (previous.failureBaseline ?? 0)) {
        rows.set(activity.id, {
          ...activity,
          state: 'failed',
          label: 'Some models could not be processed',
        })
        continue
      }
    } else if (
      !previous &&
      activity.state === 'completed' &&
      (!activity.createdAt || Date.parse(activity.createdAt) < startedAt)
    )
      continue

    rows.set(activity.id, {
      ...activity,
      finishedAt: activity.state === 'completed' ? (previous?.finishedAt ?? now) : undefined,
    })
  }
  return [...rows.values()].filter((row) => {
    if (row.finishedAt === undefined || now < row.finishedAt + SUCCESS_HOLD_MS + EXIT_MS)
      return true
    dismissed.add(row.id)
    return false
  })
}
