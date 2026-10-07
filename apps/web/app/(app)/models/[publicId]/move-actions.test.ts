import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  limit: vi.fn(),
  assertMoveAllowed: vi.fn(),
  getStartedQueue: vi.fn(),
  send: vi.fn(),
  revalidatePath: vi.fn(),
}))

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }))
// The audit trail has its own tests; here it would only write to a real database.
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => {}) }))
vi.mock('@pb/auth', () => ({
  requireUser: vi.fn().mockResolvedValue({ id: 'user', role: 'admin' }),
}))
vi.mock('@pb/core', () => ({
  MoveError: class MoveError extends Error {},
  PolicyError: class PolicyError extends Error {},
  assertCan: vi.fn(),
  assertMoveAllowed: mocks.assertMoveAllowed,
  libraryLocationFromRow: (row: unknown) => row,
  createStorageAdapter: (location: unknown) => location,
}))
vi.mock('@pb/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pb/db')>()
  const query = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: mocks.limit,
  }
  return { ...actual, getDb: () => query }
})
vi.mock('@pb/jobs', () => ({
  JOB: { modelMove: 'model.move' },
  getStartedQueue: mocks.getStartedQueue,
  // A cold web process must not send through the unstarted singleton.
  getQueue: () => ({
    send: () => {
      throw new Error('The job queue has not been started')
    },
  }),
}))

import { MoveError } from '@pb/core'
import { moveToLibrary } from './move-actions'

describe('moveToLibrary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.limit.mockReset()
    mocks.assertMoveAllowed.mockReset()
    mocks.limit
      .mockResolvedValueOnce([
        { model: { id: 'model', name: 'Dragon' }, library: { id: 'source' } },
      ])
      .mockResolvedValueOnce([{ id: 'destination', name: 'Prints' }])
    mocks.getStartedQueue.mockResolvedValue({ send: mocks.send })
    mocks.send.mockResolvedValue('job')
  })

  it('starts the web queue and enqueues a validated move', async () => {
    const result = await moveToLibrary('public-id', 'destination', 'Dragons/Dragon')

    expect(result.ok).toBe(true)
    expect(mocks.assertMoveAllowed).toHaveBeenCalledWith(
      expect.anything(),
      { id: 'source' },
      { id: 'destination', name: 'Prints' },
      'model',
      { destinationPath: 'Dragons/Dragon' },
    )
    expect(mocks.getStartedQueue).toHaveBeenCalledOnce()
    expect(mocks.send).toHaveBeenCalledWith(
      'model.move',
      { modelId: 'model', destinationLibraryId: 'destination', destinationPath: 'Dragons/Dragon' },
      { singletonKey: 'move:model' },
    )
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/models/public-id')
  })

  it('returns a preflight refusal without starting or sending to the queue', async () => {
    mocks.assertMoveAllowed.mockRejectedValue(new MoveError('That library is read-only.'))

    expect(await moveToLibrary('public-id', 'destination')).toEqual({
      ok: false,
      error: 'That library is read-only.',
    })
    expect(mocks.getStartedQueue).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })
})
