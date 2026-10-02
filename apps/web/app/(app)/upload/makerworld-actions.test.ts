import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  user: { id: 'signed-in-user', role: 'member', banned: false },
  requireUser: vi.fn(),
  assertCan: vi.fn(),
  create: vi.fn(),
  status: vi.fn(),
  queueFailed: vi.fn(),
  send: vi.fn(),
}))

vi.mock('@pb/auth', () => ({ requireUser: mocks.requireUser }))
vi.mock('@pb/db', () => ({ getDb: () => 'db' }))
vi.mock('@pb/core', () => ({
  PolicyError: class PolicyError extends Error {},
  MakerWorldImportError: class MakerWorldImportError extends Error {},
  assertCan: mocks.assertCan,
  createMakerWorldImport: mocks.create,
  getMakerWorldImportStatus: mocks.status,
  markMakerWorldImportQueueFailed: mocks.queueFailed,
}))
vi.mock('@pb/jobs', () => ({
  JOB: { makerWorldImport: 'makerworld-import' },
  getStartedQueue: async () => ({ send: mocks.send }),
}))

import { PolicyError } from '@pb/core'
import { pollMakerWorldImport, startMakerWorldImport } from './makerworld-actions'

beforeEach(() => {
  vi.resetAllMocks()
  mocks.requireUser.mockResolvedValue(mocks.user)
  mocks.create.mockResolvedValue({ id: 'import-id' })
  mocks.send.mockResolvedValue('job-id')
})

describe('MakerWorld action boundaries', () => {
  it('authorizes every call including banned state before accessing private data', async () => {
    mocks.assertCan.mockImplementation(() => {
      throw new PolicyError('file:upload')
    })
    const results = await Promise.all([
      startMakerWorldImport({ libraryId: 'lib', url: 'https://makerworld.com/en/models/1' }),
      pollMakerWorldImport('someone-elses-import'),
    ])
    expect(results.every((result) => !result.ok)).toBe(true)
    expect(mocks.requireUser).toHaveBeenCalledTimes(2)
    expect(mocks.assertCan).toHaveBeenCalledWith(mocks.user, 'file:upload')
    for (const service of [mocks.create, mocks.status]) {
      expect(service).not.toHaveBeenCalled()
    }
  })

  it('uses the signed-in identity even with extra untrusted input properties', async () => {
    const input = { userId: 'victim', libraryId: 'lib', url: 'https://makerworld.com/en/models/1' }
    expect(await startMakerWorldImport(input)).toEqual({ ok: true, id: 'import-id' })
    expect(mocks.create).toHaveBeenCalledWith('db', { ...input, userId: mocks.user.id })
    expect(mocks.send).toHaveBeenCalledWith(
      'makerworld-import',
      { importId: 'import-id' },
      { singletonKey: 'import:import-id' },
    )
  })

  it('follows a deduplicated active job without marking it failed', async () => {
    mocks.send.mockResolvedValue(null)
    mocks.status.mockResolvedValue({ state: 'importing', error: null, publicId: null })
    expect(
      await startMakerWorldImport({ libraryId: 'lib', url: 'https://makerworld.com/en/models/1' }),
    ).toEqual({ ok: true, id: 'import-id' })
    expect(mocks.queueFailed).not.toHaveBeenCalled()
  })

  it('scopes status reads to the signed-in user', async () => {
    mocks.status.mockResolvedValue(null)
    expect(await pollMakerWorldImport('private-import')).toEqual({
      ok: false,
      error: 'That import was not found.',
    })
    expect(mocks.status).toHaveBeenCalledWith('db', mocks.user.id, 'private-import')
  })

  it('marks failed enqueueing and never exposes raw queue errors', async () => {
    mocks.send.mockRejectedValue(new Error('credential-secret'))
    const result = await startMakerWorldImport({
      libraryId: 'lib',
      url: 'https://makerworld.com/en/models/1',
    })
    expect(mocks.queueFailed).toHaveBeenCalledWith('db', mocks.user.id, 'import-id')
    expect(result).toEqual({ ok: false, error: 'Could not queue the import. Please try again.' })
  })
})
