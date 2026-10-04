import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelPreviewStatus } from '@pb/core'
import { createPreviewPoller } from './preview-poller'

const status = (publicId: string, state: ModelPreviewStatus['state']): ModelPreviewStatus => ({
  publicId,
  state,
  previewImageFileId: null,
  thumbFileId: state === 'ready' ? `thumb-${publicId}` : null,
  thumbKey: null,
})

describe('preview polling', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('batches cards and only rechecks pending previews until they finish', async () => {
    const fetchStatuses = vi
      .fn()
      .mockResolvedValueOnce([
        status('a', 'pending'),
        status('b', 'ready'),
        status('c', 'unavailable'),
      ])
      .mockResolvedValueOnce([status('a', 'ready')])
    const onStatuses = vi.fn()
    const poller = createPreviewPoller({
      ids: ['a', 'b', 'c'],
      fetchStatuses,
      onStatuses,
      isVisible: () => true,
    })
    await poller.refresh()
    expect(fetchStatuses.mock.calls[0]![0]).toEqual(['a', 'b', 'c'])
    await vi.advanceTimersByTimeAsync(3000)
    expect(fetchStatuses.mock.calls[1]![0]).toEqual(['a'])
    expect(onStatuses).toHaveBeenLastCalledWith([status('a', 'ready')])
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetchStatuses).toHaveBeenCalledTimes(2)
    poller.stop()
  })

  it('pauses while hidden and resumes immediately when visible', async () => {
    let visible = false
    const fetchStatuses = vi.fn().mockResolvedValue([status('a', 'pending')])
    const poller = createPreviewPoller({
      ids: ['a'],
      fetchStatuses,
      onStatuses: vi.fn(),
      isVisible: () => visible,
    })
    await poller.refresh()
    expect(fetchStatuses).not.toHaveBeenCalled()
    visible = true
    await poller.refresh()
    visible = false
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetchStatuses).toHaveBeenCalledTimes(1)
    visible = true
    await poller.refresh()
    expect(fetchStatuses).toHaveBeenCalledTimes(2)
    poller.stop()
  })

  it('aborts on navigation and discards responses from the previous page', async () => {
    let complete!: (value: ModelPreviewStatus[]) => void
    const fetchStatuses = vi.fn(
      (_ids: string[], _signal: AbortSignal) =>
        new Promise<ModelPreviewStatus[]>((resolve) => {
          complete = resolve
        }),
    )
    const onStatuses = vi.fn()
    const poller = createPreviewPoller({
      ids: ['a'],
      fetchStatuses,
      onStatuses,
      isVisible: () => true,
    })
    const request = poller.refresh()
    await poller.refresh()
    expect(fetchStatuses).toHaveBeenCalledTimes(1)
    poller.stop()
    expect(fetchStatuses.mock.calls[0]![1].aborted).toBe(true)
    complete([status('a', 'ready')])
    await request
    expect(onStatuses).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retries temporary failures without marking processing as failed', async () => {
    const fetchStatuses = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([status('a', 'ready')])
    const onStatuses = vi.fn()
    const poller = createPreviewPoller({
      ids: ['a'],
      fetchStatuses,
      onStatuses,
      isVisible: () => true,
    })
    await poller.refresh()
    expect(onStatuses).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(6000)
    expect(onStatuses).toHaveBeenCalledWith([status('a', 'ready')])
    poller.stop()
  })

  it('stops when authorization is revoked', async () => {
    const fetchStatuses = vi.fn().mockResolvedValue(null)
    const poller = createPreviewPoller({
      ids: ['a'],
      fetchStatuses,
      onStatuses: vi.fn(),
      isVisible: () => true,
    })
    await poller.refresh()
    await vi.advanceTimersByTimeAsync(30_000)
    await poller.refresh()
    expect(fetchStatuses).toHaveBeenCalledTimes(1)
    poller.stop()
  })

  it('settles deleted models instead of polling them forever', async () => {
    const onStatuses = vi.fn()
    const poller = createPreviewPoller({
      ids: ['gone'],
      fetchStatuses: async () => [],
      onStatuses,
      isVisible: () => true,
    })
    await poller.refresh()
    expect(onStatuses).toHaveBeenCalledWith([status('gone', 'unavailable')])
    expect(vi.getTimerCount()).toBe(0)
    poller.stop()
  })

  it('splits large grids into bounded requests and deduplicates IDs', async () => {
    const ids = Array.from({ length: 205 }, (_, i) => `model-${i}`)
    const fetchStatuses = vi.fn(async (batch: string[]) => batch.map((id) => status(id, 'ready')))
    const poller = createPreviewPoller({
      ids: [...ids, ids[0]!],
      fetchStatuses,
      onStatuses: vi.fn(),
      isVisible: () => true,
    })
    await poller.refresh()
    expect(fetchStatuses.mock.calls.map(([batch]) => batch.length)).toEqual([200, 5])
    expect(vi.getTimerCount()).toBe(0)
    poller.stop()
  })
})
