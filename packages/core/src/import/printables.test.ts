import { describe, expect, it, vi } from 'vitest'
import { fetchPrintablesModel, parsePrintablesUrl } from './printables'
import type { SourceRequest } from './source-network'
const print = {
  id: '3161',
  name: '3D <b>Benchy</b>',
  description: '<p>Print &amp; test.</p><script>bad()</script>',
  user: { publicUsername: 'Prusa Research', handle: 'PrusaResearch' },
  license: { name: 'Public Domain' },
  tags: [{ name: 'boat' }, { name: 'boat' }],
  image: { filePath: 'media/prints/3161/images/benchy.jpg' },
  images: [],
  stls: [{ id: '49068', name: '3dbenchy.stl' }],
  otherFiles: [],
}
function fakeRequest(
  data: unknown = print,
  download: unknown = {
    ok: true,
    output: { link: 'https://files.printables.com/media/model.stl' },
  },
  status = 200,
) {
  return vi.fn(async (_provider: string, _url: string, options: SourceRequest) => ({
    status,
    body: Buffer.from(
      JSON.stringify({
        data: options.body?.includes('mutation') ? { getDownloadLink: download } : { print: data },
      }),
    ),
  }))
}
describe('Printables import provider', () => {
  it('canonicalizes supported URLs', () =>
    expect(
      parsePrintablesUrl('https://printables.com/en/model/3161-3d-benchy?lang=en#files'),
    ).toEqual({ sourceUrl: 'https://www.printables.com/model/3161', externalId: '3161' }))
  it.each([
    'http://printables.com/model/123',
    'https://printables.com.evil.test/model/123',
    'https://user@printables.com/model/123',
    'https://printables.com:8443/model/123',
    'https://printables.com/model/0',
    'https://printables.com/model/123/files',
  ])('rejects unsupported URL %s', (url) => expect(() => parsePrintablesUrl(url)).toThrow())
  it('retrieves public metadata and download links without credentials', async () => {
    const request = fakeRequest()
    const result = await fetchPrintablesModel('https://www.printables.com/model/3161-3d-benchy', {
      request,
    })
    expect(result).toMatchObject({
      title: '3D Benchy',
      description: 'Print & test.',
      creator: { name: 'Prusa Research', url: 'https://www.printables.com/@PrusaResearch' },
      tags: ['boat'],
      license: 'Public Domain',
      thumbnailUrl: 'https://media.printables.com/media/prints/3161/images/benchy.jpg',
      files: [{ id: '49068', filename: '3dbenchy.stl', format: 'stl' }],
    })
    expect(request.mock.calls[0]?.[2]).toMatchObject({
      method: 'POST',
      maxBytes: 4194304,
      timeoutMs: 20000,
      headers: { 'Content-Type': 'application/json' },
    })
    expect(request.mock.calls[0]?.[2].headers?.Authorization).toBeUndefined()
    expect(request.mock.calls[1]?.[2].body).toContain('fileType: stl')
  })
  it('metadata enrichment never requests download mutations', async () => {
    const request = fakeRequest()
    expect(
      (
        await fetchPrintablesModel('https://www.printables.com/model/3161', {
          request,
          metadataOnly: true,
        })
      ).files,
    ).toEqual([])
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('uses API list category rather than filename extension for a 3MF', async () => {
    const request = fakeRequest({ ...print, stls: [{ id: '49068', name: 'Cube.3mf' }] })
    const result = await fetchPrintablesModel('https://www.printables.com/model/3161', { request })
    expect(result.files[0]?.format).toBe('3mf')
    expect(request.mock.calls[1]?.[2].body).toContain('fileType: stl')
  })
  it('requests supported otherFiles using their own category and ignores documents', async () => {
    const request = fakeRequest({
      ...print,
      stls: [],
      otherFiles: [
        { id: '456', name: '../model.obj' },
        { id: '789', name: 'instructions.pdf' },
      ],
    })
    const result = await fetchPrintablesModel('https://www.printables.com/model/3161', { request })
    expect(result.files).toHaveLength(1)
    expect(result.files[0]?.filename).toBe('model.obj')
    expect(request.mock.calls[1]?.[2].body).toContain('fileType: other')
  })
  it('reports missing models', async () => {
    await expect(
      fetchPrintablesModel('https://www.printables.com/model/3161', { request: fakeRequest(null) }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
  it('rejects a mismatched model identity', async () => {
    await expect(
      fetchPrintablesModel('https://www.printables.com/model/3161', {
        request: fakeRequest({ ...print, id: '3162' }),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it('ignores unsafe optional artwork', async () => {
    expect(
      (
        await fetchPrintablesModel('https://www.printables.com/model/3161', {
          request: fakeRequest({ ...print, image: { filePath: 'https://evil.example/image.jpg' } }),
          metadataOnly: true,
        })
      ).thumbnailUrl,
    ).toBeNull()
  })
  it('rejects unsafe model downloads', async () => {
    await expect(
      fetchPrintablesModel('https://www.printables.com/model/3161', {
        request: fakeRequest(print, {
          ok: true,
          output: { link: 'https://evil.example/file.stl' },
        }),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it('respects paid or inaccessible file responses', async () => {
    await expect(
      fetchPrintablesModel('https://www.printables.com/model/3161', {
        request: fakeRequest(print, { ok: false, output: null }),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('does not leak GraphQL error messages', async () => {
    const request = vi.fn(async () => ({
      status: 200,
      body: Buffer.from(JSON.stringify({ errors: [{ message: 'secret provider details' }] })),
    }))
    await expect(
      fetchPrintablesModel('https://www.printables.com/model/3161', { request }),
    ).rejects.toThrow('unsupported API response')
  })
  it.each([
    [401, 'AUTH_REQUIRED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [429, 'RATE_LIMITED'],
    [500, 'UNAVAILABLE'],
  ])('handles status %s', async (status, code) => {
    await expect(
      fetchPrintablesModel('https://www.printables.com/model/3161', {
        request: fakeRequest(print, undefined, Number(status)),
      }),
    ).rejects.toMatchObject({ code })
  })
})
