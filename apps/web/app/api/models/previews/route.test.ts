import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getSessionUser, modelPreviewStatuses, getDb } = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  modelPreviewStatuses: vi.fn(),
  getDb: vi.fn(),
}))
vi.mock('@pb/auth', () => ({ getSessionUser }))
vi.mock('@pb/db', () => ({ getDb }))
vi.mock('@pb/core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@pb/core')>()
  return { ...original, modelPreviewStatuses }
})
import { GET } from './route'

describe('preview status endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSessionUser.mockResolvedValue({ id: 'viewer', role: 'viewer' })
    modelPreviewStatuses.mockResolvedValue([])
  })
  it('requires a session before accessing the database', async () => {
    getSessionUser.mockResolvedValue(null)
    expect((await GET(new Request('http://localhost/api/models/previews?id=a'))).status).toBe(403)
    expect(getDb).not.toHaveBeenCalled()
  })
  it('allows a signed-in viewer and never caches processing status', async () => {
    const response = await GET(new Request('http://localhost/api/models/previews?id=a&id=b'))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(modelPreviewStatuses).toHaveBeenCalledWith(undefined, ['a', 'b'])
  })
  it.each([
    '',
    '?id=',
    '?id=bad%20id',
    '?id=' + 'x'.repeat(65),
    '?' + Array(201).fill('id=a').join('&'),
  ])('rejects invalid or excessive IDs: %s', async (query) => {
    expect((await GET(new Request(`http://localhost/api/models/previews${query}`))).status).toBe(
      400,
    )
    expect(modelPreviewStatuses).not.toHaveBeenCalled()
  })
})
