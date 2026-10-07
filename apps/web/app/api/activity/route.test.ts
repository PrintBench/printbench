import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getDb: vi.fn(),
  getPool: vi.fn(),
  readActivity: vi.fn(),
}))
vi.mock('@pb/auth', () => ({ getSessionUser: mocks.getSessionUser }))
vi.mock('@pb/db', () => ({ getDb: mocks.getDb, getPool: mocks.getPool }))
vi.mock('@/lib/activity', () => ({ readActivity: mocks.readActivity }))
import { GET } from './route'
const get = (query = '') => GET(new Request(`http://localhost/api/activity${query}`))

describe('global activity endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getSessionUser.mockResolvedValue({ id: 'user', role: 'viewer' })
    mocks.readActivity.mockResolvedValue([])
  })
  it.each([null, { id: 'user', role: 'viewer', banned: true }])(
    'rejects unauthorized users before reading work: %s',
    async (user) => {
      mocks.getSessionUser.mockResolvedValue(user)
      expect((await get()).status).toBe(403)
      expect(mocks.getDb).not.toHaveBeenCalled()
      expect(mocks.readActivity).not.toHaveBeenCalled()
    },
  )
  it.each([
    ['viewer', false],
    ['member', false],
    ['admin', true],
  ])('scopes operations for %s', async (role, operations) => {
    mocks.getSessionUser.mockResolvedValue({ id: 'user', role })
    const response = await get()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(mocks.readActivity).toHaveBeenCalledWith(undefined, expect.any(Object), operations, [])
  })
  it('passes valid tracked IDs and rejects invalid IDs before reading', async () => {
    const id = 'ac710000-0000-4000-8000-000000000001'
    expect((await get(`?id=${id}`)).status).toBe(200)
    expect(mocks.readActivity).toHaveBeenLastCalledWith(undefined, expect.any(Object), false, [id])
    mocks.readActivity.mockClear()
    expect((await get('?id=invalid')).status).toBe(400)
    expect(
      (
        await get(
          '?' +
            Array.from(
              { length: 1001 },
              (_, i) => `id=${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000001`,
            ).join('&'),
        )
      ).status,
    ).toBe(400)
    expect(mocks.readActivity).not.toHaveBeenCalled()
  })
  it('reports unavailable status without leaking internal errors', async () => {
    mocks.readActivity.mockRejectedValue(new Error('private database error'))
    const response = await get()
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'Could not read activity' })
  })
})
