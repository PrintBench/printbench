import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getDb: vi.fn(),
  getPool: vi.fn(),
  readActivity: vi.fn(),
  getSettings: vi.fn(),
  peekUpdateStatus: vi.fn(),
}))
vi.mock('@pb/auth', () => ({ getSessionUser: mocks.getSessionUser }))
vi.mock('@pb/db', () => ({ getDb: mocks.getDb, getPool: mocks.getPool }))
vi.mock('@pb/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pb/core')>()),
  getSettings: mocks.getSettings,
  peekUpdateStatus: mocks.peekUpdateStatus,
}))
vi.mock('@/lib/activity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/activity')>()),
  readActivity: mocks.readActivity,
}))
import { GET } from './route'
const get = (query = '') => GET(new Request(`http://localhost/api/activity${query}`))

describe('global activity endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getSessionUser.mockResolvedValue({ id: 'user', role: 'viewer' })
    mocks.readActivity.mockResolvedValue([])
    mocks.getSettings.mockResolvedValue({ updateChecks: true })
    mocks.peekUpdateStatus.mockReturnValue(null)
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

  /*
   * Only the people who can act on an upgrade hear about one, and only while
   * the instance is configured to look. Everything else is a release feed
   * being read on behalf of someone who cannot do anything about it.
   */
  it('announces a new version to admins only', async () => {
    mocks.peekUpdateStatus.mockReturnValue({
      currentVersion: '0.7.6',
      latestVersion: '0.9.0',
      releaseUrl: 'https://github.com/PrintBench/printbench/releases/latest',
      checkedAt: new Date(0).toISOString(),
      updateAvailable: true,
      failed: false,
    })

    mocks.getSessionUser.mockResolvedValue({ id: 'user', role: 'member' })
    expect((await (await get()).json()).activities).toEqual([])
    expect(mocks.peekUpdateStatus).not.toHaveBeenCalled()

    mocks.getSessionUser.mockResolvedValue({ id: 'user', role: 'admin' })
    expect((await (await get()).json()).activities).toEqual([
      expect.objectContaining({ kind: 'update', state: 'available', version: '0.9.0' }),
    ])
  })

  it('reads nothing when version checks are turned off', async () => {
    mocks.getSessionUser.mockResolvedValue({ id: 'user', role: 'admin' })
    mocks.getSettings.mockResolvedValue({ updateChecks: false })
    expect((await (await get()).json()).activities).toEqual([])
    expect(mocks.peekUpdateStatus).not.toHaveBeenCalled()
  })
})
