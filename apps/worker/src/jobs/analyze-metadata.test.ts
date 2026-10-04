import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'

const mocks = vi.hoisted(() => ({
  rows: [] as any[],
  patches: [] as any[],
  storage: { createReadStream: vi.fn() },
  store: { has: vi.fn(), write: vi.fn() },
  apply: vi.fn(),
  canonical: vi.fn(),
  fetchProject: vi.fn(),
  readMetadata: vi.fn(),
  cover: vi.fn(),
  analyze: vi.fn(),
  render: vi.fn(),
  key: vi.fn(),
}))

vi.mock('@pb/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pb/db')>()
  return {
    ...actual,
    getDb: () => ({
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            innerJoin: () => ({ where: () => ({ limit: async () => mocks.rows }) }),
          }),
        }),
      }),
      update: () => ({
        set: (patch: any) => {
          mocks.patches.push(patch)
          return { where: async () => {} }
        },
      }),
    }),
  }
})
vi.mock('@pb/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pb/core')>()
  return {
    ...actual,
    createStorageAdapter: () => mocks.storage,
    getPreviewStore: () => mocks.store,
    applyEmbeddedModelMetadata: mocks.apply,
    isEmbeddedMetadataSource: mocks.canonical,
    fetchMakerWorldProjectMetadata: mocks.fetchProject,
    previewKey: mocks.key,
  }
})
vi.mock('@pb/mesh', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pb/mesh')>()
  return {
    ...actual,
    readThreeMfMetadataFromSource: mocks.readMetadata,
    renderEmbeddedThumbnail: mocks.cover,
    analyzeMesh: mocks.analyze,
    renderThumbnail: mocks.render,
  }
})

import { handleFileAnalyze, handleFileThumbnail } from './analyze'
import { RENDERER_VERSION, THREEMF_METADATA_VERSION } from '@pb/mesh'

describe('worker embedded metadata and covers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.patches = []
    mocks.rows = [
      {
        file: {
          id: 'file-1',
          modelId: 'model-1',
          filename: 'project.3mf',
          extension: '3mf',
          size: 100,
          digest: null,
          mtimeMs: 1,
          missingAt: null,
        },
        model: {
          id: 'model-1',
          path: '104',
          isFileModel: false,
          embeddedMetadataState: 'pending',
          previewFileId: 'manual-preview',
        },
        library: {
          id: 'lib-1',
          kind: 'managed',
          backend: 'local',
          path: '/models',
          allowWrites: true,
        },
      },
    ]
    mocks.storage.createReadStream.mockImplementation(async () =>
      Readable.from(Buffer.from('fixture')),
    )
    mocks.store.has.mockResolvedValue(false)
    mocks.store.write.mockResolvedValue(undefined)
    mocks.key.mockReturnValue('ab/cd/preview.webp')
    mocks.canonical.mockResolvedValue(true)
    mocks.apply.mockResolvedValue({ applied: true })
    mocks.readMetadata.mockResolvedValue({
      title: 'Designer title',
      thumbnails: [{ data: Buffer.from('image'), path: 'cover.png', contentType: 'image/png' }],
    })
    mocks.cover.mockResolvedValue({
      data: Buffer.from('webp-cover'),
      width: 512,
      height: 256,
      contentType: 'image/webp',
    })
    mocks.analyze.mockResolvedValue({
      triangleCount: 12,
      bbox: { minX: 0, minY: 0, minZ: 0, maxX: 20, maxY: 20, maxZ: 20 },
      unit: 'mm',
    })
    mocks.render.mockResolvedValue({ data: Buffer.from('rasterized') })
  })

  it('enriches recognized MakerWorld projects with public tags and provenance before one metadata save', async () => {
    mocks.readMetadata.mockResolvedValue({
      title: 'Embedded title',
      description: 'Package description',
      creationDate: '2026-07-02',
      sourceIdentifiers: { 'MakerWorld internal design ID': 'USexample' },
      thumbnails: [],
    })
    const source = {
      title: 'Public title',
      description: 'Full source description',
      license: 'BY',
      creator: { name: 'Source maker' },
      sourceUrl: 'https://makerworld.com/en/models/123',
      tags: ['bread'],
      files: [],
    }
    mocks.fetchProject.mockResolvedValue(source)
    await handleFileAnalyze({ fileId: 'file-1' })
    expect(mocks.fetchProject).toHaveBeenCalledWith('USexample')
    expect(mocks.apply).toHaveBeenCalledWith(
      expect.anything(),
      'model-1',
      'file-1',
      expect.objectContaining({
        title: 'Public title',
        designer: 'Source maker',
        description: 'Full source description',
        creationDate: '2026-07-02',
      }),
      source,
    )
    expect(mocks.analyze).toHaveBeenCalled()
  })

  it('does not read metadata or request remote details for a noncanonical variant file', async () => {
    mocks.canonical.mockResolvedValue(false)
    await handleFileAnalyze({ fileId: 'file-1' })
    expect(mocks.readMetadata).not.toHaveBeenCalled()
    expect(mocks.fetchProject).not.toHaveBeenCalled()
    expect(mocks.apply).not.toHaveBeenCalled()
    expect(mocks.analyze).toHaveBeenCalled()
  })

  it('falls back to embedded fields when public MakerWorld enrichment fails', async () => {
    const metadata = {
      title: 'Offline title',
      sourceIdentifiers: { 'MakerWorld internal design ID': 'USexample' },
      thumbnails: [],
    }
    mocks.readMetadata.mockResolvedValue(metadata)
    mocks.fetchProject.mockRejectedValue(new Error('Provider refused request'))
    await handleFileAnalyze({ fileId: 'file-1' })
    expect(mocks.apply).toHaveBeenCalledWith(expect.anything(), 'model-1', 'file-1', metadata)
    expect(mocks.analyze).toHaveBeenCalled()
  })

  it('does not contact a provider for projects without recognized source identity', async () => {
    await handleFileAnalyze({ fileId: 'file-1' })
    expect(mocks.fetchProject).not.toHaveBeenCalled()
  })

  it('saves descriptive metadata independently of an unsupported or corrupt geometry result', async () => {
    mocks.analyze.mockRejectedValue(new Error('Unsupported component geometry'))
    await handleFileAnalyze({ fileId: 'file-1' })
    expect(mocks.apply).toHaveBeenCalledWith(
      expect.anything(),
      'model-1',
      'file-1',
      expect.objectContaining({ title: 'Designer title' }),
    )
    expect(mocks.patches).toContainEqual(expect.objectContaining({ analysisState: 'failed' }))
  })

  it('settles malformed metadata without blocking valid geometry analysis', async () => {
    mocks.readMetadata.mockRejectedValue(new Error('Bad metadata XML'))
    await handleFileAnalyze({ fileId: 'file-1' })
    expect(mocks.apply).toHaveBeenCalledWith(expect.anything(), 'model-1', 'file-1', {})
    expect(mocks.patches).toContainEqual(
      expect.objectContaining({ analysisState: 'ok', triangleCount: 12 }),
    )
  })

  it('leaves existing and explicitly edited model metadata alone', async () => {
    mocks.rows[0].model.embeddedMetadataState = 'done'
    await handleFileAnalyze({ fileId: 'file-1' })
    expect(mocks.readMetadata).not.toHaveBeenCalled()
    expect(mocks.apply).not.toHaveBeenCalled()
    expect(mocks.analyze).toHaveBeenCalled()
  })

  it('uses a valid embedded cover without requiring geometry or changing manual preview selection', async () => {
    await handleFileThumbnail({ fileId: 'file-1' })
    expect(mocks.store.write).toHaveBeenCalledWith('ab/cd/preview.webp', Buffer.from('webp-cover'))
    expect(mocks.render).not.toHaveBeenCalled()
    expect(mocks.patches).toEqual([
      { thumbKey: 'ab/cd/preview.webp', thumbState: 'ok', thumbError: null },
    ])
    expect(mocks.key).toHaveBeenCalledWith(
      expect.objectContaining({
        rendererVersion: RENDERER_VERSION * 1000 + THREEMF_METADATA_VERSION,
      }),
    )
  })

  it('falls back to geometry with legacy embedded-image decoding disabled', async () => {
    mocks.cover.mockResolvedValue(null)
    await handleFileThumbnail({ fileId: 'file-1' })
    expect(mocks.render).toHaveBeenCalledWith(
      '3mf',
      expect.any(Function),
      expect.objectContaining({ preferEmbedded: false }),
    )
    expect(mocks.store.write).toHaveBeenCalledWith('ab/cd/preview.webp', Buffer.from('rasterized'))
  })

  it('serves cached previews without decoding the project again', async () => {
    mocks.store.has.mockResolvedValue(true)
    await handleFileThumbnail({ fileId: 'file-1' })
    expect(mocks.readMetadata).not.toHaveBeenCalled()
    expect(mocks.render).not.toHaveBeenCalled()
    expect(mocks.patches[0]).toMatchObject({ thumbState: 'ok' })
  })
})
