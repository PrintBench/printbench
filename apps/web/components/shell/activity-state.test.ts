import { describe, expect, it } from 'vitest'
import type { Activity } from '../../lib/activity'
import { reconcileActivity, SUCCESS_HOLD_MS, EXIT_MS } from './activity-state'

const scan: Activity = {
  id: 'scan-1',
  kind: 'scan',
  state: 'running',
  label: 'Scanning…',
  href: '/admin/libraries',
}
const processing: Activity = {
  id: 'model-processing',
  kind: 'processing',
  state: 'running',
  label: 'Processing 3 models…',
  href: '/models',
  count: 3,
  failures: 5,
}

describe('global activity lifecycle', () => {
  it('keeps observed work until an explicit terminal status arrives', () => {
    const dismissed = new Set<string>()
    const running = reconcileActivity([], [scan], dismissed, 0, 100)
    expect(reconcileActivity(running, [], dismissed, 0, 200)).toEqual(running)
    const finished = reconcileActivity(
      running,
      [{ ...scan, state: 'completed' }],
      dismissed,
      0,
      300,
    )
    expect(finished[0]?.finishedAt).toBe(300)
    expect(
      reconcileActivity(finished, [{ ...scan, state: 'completed' }], dismissed, 0, 500)[0]
        ?.finishedAt,
    ).toBe(300)
    expect(reconcileActivity(finished, [], dismissed, 0, 300 + SUCCESS_HOLD_MS + EXIT_MS)).toEqual(
      [],
    )
    expect(reconcileActivity([], [{ ...scan, state: 'completed' }], dismissed, 0, 6000)).toEqual([])
  })

  it('does not announce idle processing or historical successful jobs on load', () => {
    expect(
      reconcileActivity(
        [],
        [
          { ...processing, state: 'completed', count: 0 },
          { ...scan, state: 'completed', createdAt: new Date(10).toISOString() },
        ],
        new Set(),
        100,
        200,
      ),
    ).toEqual([])
  })

  it('catches short jobs that started and completed between polls', () => {
    expect(
      reconcileActivity(
        [],
        [{ ...scan, state: 'completed', createdAt: new Date(150).toISOString() }],
        new Set(),
        100,
        200,
      )[0]?.finishedAt,
    ).toBe(200)
  })

  it('keeps failures visible until dismissed', () => {
    const dismissed = new Set<string>()
    const failed = { ...scan, state: 'failed' as const }
    const rows = reconcileActivity([], [failed], dismissed, 0, 100)
    expect(reconcileActivity(rows, [], dismissed, 0, 100000)[0]?.state).toBe('failed')
    dismissed.add(scan.id)
    expect(reconcileActivity([], [failed], dismissed, 0, 100001)).toEqual([])
  })

  it('detects model failures that occurred while other models were still processing', () => {
    const dismissed = new Set<string>()
    const rows = reconcileActivity([], [processing], dismissed, 0, 100)
    const partlyFailed = reconcileActivity(
      rows,
      [{ ...processing, count: 1, failures: 6 }],
      dismissed,
      0,
      200,
    )
    const finished = reconcileActivity(
      partlyFailed,
      [{ ...processing, state: 'completed', count: 0, failures: 6 }],
      dismissed,
      0,
      300,
    )
    expect(finished[0]?.state).toBe('failed')
    expect(finished[0]?.finishedAt).toBeUndefined()
  })

  it('allows a fresh processing batch after the previous batch was dismissed', () => {
    const dismissed = new Set([processing.id])
    const rows = reconcileActivity([], [processing], dismissed, 0, 100)
    expect(rows[0]?.state).toBe('running')
    expect(dismissed.has(processing.id)).toBe(false)
    const finished = reconcileActivity(
      rows,
      [{ ...processing, state: 'completed', count: 0 }],
      dismissed,
      0,
      200,
    )
    expect(finished[0]?.state).toBe('completed')
  })
})
