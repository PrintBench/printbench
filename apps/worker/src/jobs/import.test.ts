import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import sharp from 'sharp'
import { zipSync, strToU8 } from 'fflate'
import type { MakerWorldImportDependencies } from '../../../../packages/core/src/import/import-service'

const mocks = vi.hoisted(() => ({
  process: vi.fn(),
  makerworld: vi.fn(),
  printables: vi.fn(),
  thingiverse: vi.fn(),
  downloadMakerworld: vi.fn(),
  downloadSource: vi.fn(),
  sendMany: vi.fn(),
}))
vi.mock('@pb/core', async (original) => ({
  ...(await original<typeof import('@pb/core')>()),
  processMakerWorldImport: mocks.process,
  fetchMakerWorldModel: mocks.makerworld,
  fetchPrintablesModel: mocks.printables,
  fetchThingiverseModel: mocks.thingiverse,
  downloadMakerWorldFile: mocks.downloadMakerworld,
  downloadSourceFile: mocks.downloadSource,
}))
vi.mock('@pb/db', () => ({ getDb: () => ({}) }))
vi.mock('@pb/jobs', async (original) => ({
  ...(await original<typeof import('@pb/jobs')>()),
  getQueue: () => ({ sendMany: mocks.sendMany }),
}))
import { handleMakerWorldImport } from './import'

const context = { provider: 'printables' as const, token: '' }
const triangle = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0])
function threeMf(): Buffer {
  return Buffer.from(
    zipSync(
      {
        '3D/3dmodel.model': strToU8(
          '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>',
        ),
      },
      { mtime: new Date('2020-01-01T00:00:00Z') },
    ),
  )
}
async function consume(stream: Readable) {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}
function downloadBytes(bytes: Buffer) {
  const write = async (_url: string, filename: string) => {
    await writeFile(filename, bytes, { flag: 'wx' })
    return bytes.length
  }
  mocks.downloadMakerworld.mockImplementation(write)
  mocks.downloadSource.mockImplementation((_provider: string, url: string, filename: string) =>
    write(url, filename),
  )
}
function runWith(callback: (deps: MakerWorldImportDependencies) => Promise<void>) {
  mocks.process.mockImplementation(
    async (_db: unknown, _id: string, deps: MakerWorldImportDependencies) => callback(deps),
  )
  return handleMakerWorldImport({ importId: 'test-import' })
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.makerworld.mockResolvedValue({ title: 'MakerWorld' })
  mocks.printables.mockResolvedValue({ title: 'Printables' })
  mocks.thingiverse.mockResolvedValue({ title: 'Thingiverse' })
})

describe('model source import worker', () => {
  it('dispatches each source to its own provider and never gives Printables an account credential', async () => {
    await runWith(async (deps) => {
      await deps.fetchModel('https://makerworld.com/en/models/123', 'mw-token')
      await deps.fetchModel('https://www.printables.com/model/123-model', 'unrelated-token')
      await deps.fetchModel('https://www.thingiverse.com/thing:123', 'tv-token')
    })
    expect(mocks.makerworld).toHaveBeenCalledWith(
      'https://makerworld.com/en/models/123',
      'mw-token',
    )
    expect(mocks.printables).toHaveBeenCalledWith('https://www.printables.com/model/123-model')
    expect(mocks.thingiverse).toHaveBeenCalledWith(
      'https://www.thingiverse.com/thing:123',
      'tv-token',
    )
  })
  it('rejects unsupported source URLs before contacting any provider', async () => {
    await expect(
      runWith(async (deps) => {
        await deps.fetchModel('https://evil.example/model/123', 'token')
      }),
    ).rejects.toThrow('model URL')
    expect(mocks.makerworld).not.toHaveBeenCalled()
    expect(mocks.printables).not.toHaveBeenCalled()
    expect(mocks.thingiverse).not.toHaveBeenCalled()
  })
  it('validates a 3MF download and deletes its temporary file after consumption', async () => {
    const bytes = threeMf()
    downloadBytes(bytes)
    await runWith(async (deps) => {
      expect(
        await consume(await deps.download('https://files.printables.com/cube.3mf', '3mf', context)),
      ).toEqual(bytes)
    })
    expect(mocks.downloadMakerworld).not.toHaveBeenCalled()
    expect(mocks.downloadSource.mock.calls[0]?.[3]).toEqual({ maxBytes: 536870912, token: '' })
    await expect(readFile(mocks.downloadSource.mock.calls[0]![2] as string)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
  it.each(['stl', 'obj', 'ply'] as const)(
    'validates %s geometry with the matching parser',
    async (format) => {
      const sources = {
        stl: 'solid cube\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 0\nendloop\nendfacet\nendsolid cube\n',
        obj: 'v 0 0 0\nv 10 0 0\nv 0 10 0\nf 1 2 3\n',
        ply: 'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n10 0 0\n0 10 0\n3 0 1 2\n',
      }
      const bytes = Buffer.from(sources[format])
      downloadBytes(bytes)
      await runWith(async (deps) => {
        expect(
          await consume(
            await deps.download(`https://cdn.thingiverse.com/model.${format}`, format, {
              provider: 'thingiverse',
              token: 'own-token',
            }),
          ),
        ).toEqual(bytes)
      })
      expect(mocks.downloadSource.mock.calls[0]?.[0]).toBe('thingiverse')
      expect(mocks.downloadSource.mock.calls[0]?.[3]).toMatchObject({ token: 'own-token' })
    },
  )
  it.each(['stl', '3mf', 'obj', 'ply'] as const)(
    'rejects HTML masquerading as %s and cleans the temporary file',
    async (format) => {
      downloadBytes(Buffer.from('<html>Access denied</html>'))
      await expect(
        runWith(async (deps) => {
          await deps.download('https://files.printables.com/model', format, context)
        }),
      ).rejects.toThrow()
      await expect(
        readFile(mocks.downloadSource.mock.calls[0]![2] as string),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )
  it('rejects incomplete binary STL geometry', async () => {
    const bytes = Buffer.alloc(134)
    bytes.writeUInt32LE(2, 80)
    triangle.forEach((value, i) => bytes.writeFloatLE(value, 96 + i * 4))
    downloadBytes(bytes)
    await expect(
      runWith(async (deps) => {
        await deps.download('https://files.printables.com/model.stl', 'stl', context)
      }),
    ).rejects.toThrow('complete 3D geometry')
  })
  it('uses MakerWorld protected transport only for its own files', async () => {
    downloadBytes(threeMf())
    await runWith(async (deps) => {
      await consume(
        await deps.download('https://makerworld.bblmw.com/model.3mf', '3mf', {
          provider: 'makerworld',
          token: 'mw-token',
        }),
      )
    })
    expect(mocks.downloadSource).not.toHaveBeenCalled()
    expect(mocks.downloadMakerworld.mock.calls[0]?.[2]).toEqual({ maxBytes: 536870912 })
  })
  it('retains up to 2048 pixels of remote artwork and uses the bounded 16 MiB limit', async () => {
    const bytes = await sharp({
      create: { width: 1200, height: 800, channels: 3, background: '#aabbcc' },
    })
      .png()
      .toBuffer()
    downloadBytes(bytes)
    await runWith(async (deps) => {
      const image = await consume(
        await deps.download('https://media.printables.com/image.png', 'image', context),
      )
      expect(await sharp(image).metadata()).toMatchObject({
        width: 1200,
        height: 800,
        format: 'webp',
      })
    })
    expect(mocks.downloadSource.mock.calls[0]?.[3]).toMatchObject({ maxBytes: 16777216 })
  })
  it('rejects unsupported artwork and removes temporary bytes', async () => {
    downloadBytes(Buffer.from('<svg></svg>'))
    await expect(
      runWith(async (deps) => {
        await deps.download('https://media.printables.com/image.svg', 'image', context)
      }),
    ).rejects.toThrow('Unsupported artwork')
    await expect(readFile(mocks.downloadSource.mock.calls[0]![2] as string)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
  it('requires trusted source context before opening a download', async () => {
    await expect(
      runWith(async (deps) => {
        await deps.download('https://files.printables.com/model.stl', 'stl')
      }),
    ).rejects.toThrow('context')
    expect(mocks.downloadSource).not.toHaveBeenCalled()
  })
  it('schedules the standard derived work after import', async () => {
    await runWith(async (deps) => {
      await deps.onDerivedWork?.(['file-1'])
    })
    expect(mocks.sendMany).toHaveBeenCalledTimes(3)
    for (const call of mocks.sendMany.mock.calls) expect(call[1]).toEqual([{ fileId: 'file-1' }])
  })
})
