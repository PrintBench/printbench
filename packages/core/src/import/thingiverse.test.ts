import { describe, expect, it, vi } from 'vitest'
import {
  fetchThingiverseModel,
  normalizeThingiverseToken,
  parseThingiverseUrl,
} from './thingiverse'
import type { SourceRequest } from './source-network'
const thing = {
  id: 123,
  name: 'Tiny <b>mixer</b>',
  description_html: '<p>Print it &amp; enjoy.</p><script>bad()</script>',
  license: 'cc',
  creator: { name: 'maker' },
  default_image: { url: 'https://cdn.thingiverse.com/assets/image.jpg' },
}
const files = [
  { id: 456, name: '../../Mixer.STL', direct_url: 'https://cdn.thingiverse.com/assets/mixer.stl' },
  { id: 789, name: 'instructions.pdf' },
]
function fakeRequest(overrides: Record<string, unknown> = {}, status = 200) {
  return vi.fn(async (_provider: string, url: string, _options: SourceRequest) => ({
    status,
    body: Buffer.from(
      JSON.stringify(
        overrides[url] ??
          (url.endsWith('/files')
            ? files
            : url.endsWith('/tags')
              ? [{ name: 'kitchen' }, { name: 'kitchen' }]
              : thing),
      ),
    ),
  }))
}
describe('Thingiverse import provider', () => {
  it('canonicalizes a public model URL', () =>
    expect(parseThingiverseUrl('https://thingiverse.com/thing:123?foo=bar#files')).toEqual({
      sourceUrl: 'https://www.thingiverse.com/thing:123',
      externalId: '123',
    }))
  it.each([
    'http://www.thingiverse.com/thing:123',
    'https://thingiverse.com.evil.test/thing:123',
    'https://user@thingiverse.com/thing:123',
    'https://www.thingiverse.com:8443/thing:123',
    'https://www.thingiverse.com/thing:0',
    'https://www.thingiverse.com/thing:123/files',
  ])('rejects unsupported URL %s', (url) => expect(() => parseThingiverseUrl(url)).toThrow())
  it('normalizes an explicit access token', () =>
    expect(normalizeThingiverseToken(' Bearer own-token ')).toBe('own-token'))
  it.each(['', 'token=secret', 'a\r\nb', 'x'.repeat(16385)])(
    'rejects malformed credentials',
    (value) => expect(() => normalizeThingiverseToken(value)).toThrow(),
  )
  it('requires a user-supplied credential before requesting the API', async () => {
    const request = fakeRequest()
    await expect(
      fetchThingiverseModel('https://www.thingiverse.com/thing:123', undefined, { request }),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    expect(request).not.toHaveBeenCalled()
  })
  it('imports metadata and supported model files with bounded authenticated API requests', async () => {
    const request = fakeRequest()
    const result = await fetchThingiverseModel(
      'https://www.thingiverse.com/thing:123',
      'own-token',
      { request },
    )
    expect(result).toMatchObject({
      title: 'Tiny mixer',
      description: 'Print it & enjoy.',
      tags: ['kitchen'],
      creator: { name: 'maker' },
      files: [{ id: '456', filename: 'Mixer.stl', format: 'stl' }],
    })
    expect(result.files).toHaveLength(1)
    for (const call of request.mock.calls)
      expect(call[2]).toMatchObject({
        maxBytes: 4194304,
        timeoutMs: 20000,
        headers: { Authorization: 'Bearer own-token' },
      })
  })
  it('metadata-only enrichment never resolves download links', async () => {
    const request = fakeRequest()
    expect(
      (
        await fetchThingiverseModel('https://www.thingiverse.com/thing:123', 'own-token', {
          request,
          metadataOnly: true,
        })
      ).files,
    ).toEqual([])
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('rejects a mismatched source identity', async () => {
    await expect(
      fetchThingiverseModel('https://www.thingiverse.com/thing:123', 'own-token', {
        request: fakeRequest({ 'https://api.thingiverse.com/things/123': { ...thing, id: 124 } }),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it('rejects unsafe download URLs', async () => {
    await expect(
      fetchThingiverseModel('https://www.thingiverse.com/thing:123', 'own-token', {
        request: fakeRequest({
          'https://api.thingiverse.com/things/123/files': [
            { id: 456, name: 'model.stl', direct_url: 'https://attacker.example/file.stl' },
          ],
        }),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it('uses the fixed API download endpoint when the API omits a direct URL', async () => {
    const result = await fetchThingiverseModel(
      'https://www.thingiverse.com/thing:123',
      'own-token',
      {
        request: fakeRequest({
          'https://api.thingiverse.com/things/123/files': [{ id: 456, name: 'model.obj' }],
        }),
      },
    )
    expect(result.files[0]?.url).toBe('https://api.thingiverse.com/files/456/download')
  })
  it('accepts current v2 download URLs without changing their query bytes', async () => {
    const url = 'https://api.thingiverse.com/v2/files/456/download?increment_download=false'
    const result = await fetchThingiverseModel(
      'https://www.thingiverse.com/thing:123',
      'own-token',
      {
        request: fakeRequest({
          'https://api.thingiverse.com/things/123/files': [
            { id: 456, name: 'model.stl', direct_url: url },
          ],
        }),
      },
    )
    expect(result.files[0]?.url).toBe(url)
  })
  it.each(['v2/files/457/download', 'v3/files/456/download', 'v2/files/456/delete'])(
    'rejects a mismatched or unsupported API download path %s',
    async (pathname) => {
      await expect(
        fetchThingiverseModel('https://www.thingiverse.com/thing:123', 'own-token', {
          request: fakeRequest({
            'https://api.thingiverse.com/things/123/files': [
              { id: 456, name: 'model.stl', direct_url: `https://api.thingiverse.com/${pathname}` },
            ],
          }),
        }),
      ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    },
  )
  it.each([
    [401, 'AUTH_REQUIRED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [429, 'RATE_LIMITED'],
    [500, 'UNAVAILABLE'],
  ])('reports HTTP %s without disclosing provider content', async (status, code) => {
    await expect(
      fetchThingiverseModel('https://www.thingiverse.com/thing:123', 'own-token', {
        request: fakeRequest({}, Number(status)),
      }),
    ).rejects.toMatchObject({ code })
  })
})
