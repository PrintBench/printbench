// @covers IMPORT-003
// @contract clipper/client
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchLibraries,
  hostPermission,
  installationOrigin,
  modelSource,
  submitImport,
} from './client'

afterEach(() => vi.unstubAllGlobals())

describe('clipper request boundaries', () => {
  it.each(['localhost', '127.0.0.1', '[::1]'])('supports loopback HTTP at %s', (host) => {
    const origin = 'http://' + host + ':8080'
    expect(installationOrigin(origin + '/')).toBe(origin)
    expect(hostPermission(origin)).toEqual({ origins: ['http://' + host + '/*'] })
  })

  it.each([
    'http://printbench.home',
    'http://192.168.1.10',
    'http://localhost.example.test',
    'https://user:password@printbench.example',
    'https://printbench.example/subpath',
    'https://printbench.example/?url=example',
    'https://printbench.example/#fragment',
    'file:///etc/hosts',
  ])('rejects unsuitable server addresses such as %s', (url) => {
    expect(() => installationOrigin(url)).toThrow()
  })

  it('uses the app parser and preserves only the meaningful MakerWorld fragment', () => {
    const result = modelSource(
      'https://makerworld.com/en/models/123-example?ref=example#profileId-456',
    )
    expect(result?.sourceUrl).toBe('https://makerworld.com/en/models/123#profileId-456')
    expect(modelSource('https://www.printables.com/model/9-model?ref=example')?.sourceUrl).toBe(
      'https://www.printables.com/model/9',
    )
    expect(modelSource('https://www.thingiverse.com/thing:9')?.sourceUrl).toBe(
      'https://www.thingiverse.com/thing:9',
    )
    expect(modelSource('https://makerworld.com/en/search')).toBeNull()
  })

  it('only sends credentials to the configured origin and disables redirects and cookies', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ id: 'import-id' }))
    vi.stubGlobal('fetch', fetch)
    const connection = { id: 'connection', origin: 'https://example.test:8443', token: 'example' }
    const input = {
      url: 'https://makerworld.com/en/models/123#profileId-456',
      libraryId: 'library',
    }
    await expect(submitImport(connection, input)).resolves.toEqual({ id: 'import-id' })
    expect(fetch).toHaveBeenCalledWith(
      'https://example.test:8443/api/v1/clipper/imports',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        credentials: 'omit',
        headers: { Authorization: 'Bearer example', 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    )
  })

  it('gives actionable feedback for expired credentials and older servers', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }))
      .mockResolvedValueOnce(new Response('missing', { status: 404 }))
    vi.stubGlobal('fetch', fetch)
    const connection = { id: 'connection', origin: 'https://example.test', token: 'example' }
    await expect(fetchLibraries(connection)).rejects.toThrow(/generate a new token/i)
    await expect(fetchLibraries(connection)).rejects.toThrow(/upgrade PrintBench/i)
  })
})
