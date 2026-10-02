import { describe, expect, it, vi } from 'vitest'
import { fetchMakerWorldModel, normalizeMakerWorldCookie, parseMakerWorldUrl } from './makerworld'
import { isPublicAddress, validateMakerWorldRemoteUrl } from './makerworld-network'

// Small synthetic fixture matching the publicly observed Bambu API field shape.
// The instance's id is the page profile ID; profileId is a different internal ID.
const design = {
  id: 123,
  modelId: 'USexample',
  title: 'Useful &amp; Model',
  summary: '<p>First paragraph.</p><script>untrusted()</script><p>Second &lt;test&gt;.</p>',
  license: 'BY',
  tags: ['tools', 'tools', 'test'],
  designCreator: { name: 'Example Maker', handle: 'example-maker' },
  coverUrl: 'https://makerworld.bblmw.com/cover.png',
  instances: [
    { id: 456, profileId: 999, title: 'Default' },
    { id: 789, title: 'Alternate' },
  ],
}
const response = (body: unknown, status = 200) => ({
  status,
  body: Buffer.from(JSON.stringify(body)),
})

describe('MakerWorld provider', () => {
  it('reads public metadata without sending credentials or resolving downloads', async () => {
    const request = vi.fn().mockResolvedValue(response(design))
    const model = await fetchMakerWorldModel(
      'https://makerworld.com/en/models/123-slug',
      undefined,
      { request },
    )
    expect(model).toMatchObject({
      title: 'Useful & Model',
      description: 'First paragraph.\nSecond <test>.',
      license: 'BY',
      tags: ['tools', 'test'],
      sourceUrl: 'https://makerworld.com/en/models/123',
      files: [],
    })
    expect(model.profiles[0]?.id).toBe('456')
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]?.[1].headers).toEqual({})
  })

  it('resolves the selected profile with only the token, preserving signed URL bytes', async () => {
    const url = 'https://s3.us-west-2.amazonaws.com/bucket/file?key=a%2Fb&key=c+z'
    const request = vi
      .fn()
      .mockResolvedValueOnce(response(design))
      .mockResolvedValueOnce(response({ url, name: '..%2FUseful%20Model.3mf' }))
    const model = await fetchMakerWorldModel(
      'https://makerworld.com/en/models/123#profileId-789',
      'other=secret; token=own.token; analytics=discard',
      { request },
    )
    expect(model.files).toEqual([{ profileId: '789', filename: 'Useful Model.3mf', url }])
    expect(request.mock.calls[0]?.[1].headers).toEqual({})
    expect(request.mock.calls[1]?.[0]).toBe(
      'https://api.bambulab.com/v1/iot-service/api/user/profile/789?model_id=USexample',
    )
    expect(request.mock.calls[1]?.[1].headers).toEqual({ Authorization: 'Bearer own.token' })
  })

  it('selects one default profile rather than every profile, and deduplicates explicit selections', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(response(design))
      .mockResolvedValue(response({ url: 'https://makerworld.bblmw.com/model.3mf' }))
    const model = await fetchMakerWorldModel('https://makerworld.com/models/123', 'token=value', {
      request,
    })
    expect(model.files).toHaveLength(1)
    expect(model.files[0]?.profileId).toBe('456')
    request
      .mockReset()
      .mockResolvedValueOnce(response(design))
      .mockResolvedValue(response({ url: 'https://makerworld.bblmw.com/model.3mf' }))
    expect(
      (
        await fetchMakerWorldModel('https://makerworld.com/models/123', 'value', {
          request,
          profileIds: ['456', '456'],
        })
      ).files,
    ).toHaveLength(1)
  })

  it('rejects a profile not belonging to the resolved design before an authenticated request', async () => {
    const request = vi.fn().mockResolvedValue(response(design))
    await expect(
      fetchMakerWorldModel('https://makerworld.com/models/123#profileId-42', 'value', { request }),
    ).rejects.toMatchObject({ code: 'INVALID_URL' })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each([
    [401, 'AUTH_REQUIRED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [429, 'RATE_LIMITED'],
    [302, 'UNAVAILABLE'],
  ])('handles %s without exposing response contents or retrying', async (status, code) => {
    const request = vi
      .fn()
      .mockResolvedValue(response({ private: 'sensitive response' }, Number(status)))
    await expect(
      fetchMakerWorldModel('https://makerworld.com/models/123', 'token=secret', { request }),
    ).rejects.toMatchObject({ code })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('never propagates transport exceptions containing credentials', async () => {
    const request = vi.fn().mockRejectedValue(new Error('token=secret'))
    await expect(
      fetchMakerWorldModel('https://makerworld.com/models/123', 'secret', { request }),
    ).rejects.toThrow('MakerWorld could not be reached')
  })

  it.each([
    { ...design, id: 456 },
    { ...design, title: '' },
    { ...design, modelId: '../../path' },
  ])('rejects invalid or mismatched metadata', async (fixture) => {
    await expect(
      fetchMakerWorldModel('https://makerworld.com/models/123', undefined, {
        request: vi.fn().mockResolvedValue(response(fixture)),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('ignores unsafe optional artwork and refuses unsafe download URLs', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(response({ ...design, coverUrl: 'http://127.0.0.1/private' }))
      .mockResolvedValueOnce(response({ url: 'https://attacker.example/private' }))
    await expect(
      fetchMakerWorldModel('https://makerworld.com/models/123', 'value', { request }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(
      (
        await fetchMakerWorldModel('https://makerworld.com/models/123', undefined, {
          request: vi
            .fn()
            .mockResolvedValue(response({ ...design, coverUrl: 'http://127.0.0.1/private' })),
        })
      ).thumbnailUrl,
    ).toBeNull()
  })
})

describe('MakerWorld boundaries', () => {
  it.each([
    'http://makerworld.com/models/123',
    'https://makerworld.com.evil.test/models/123',
    'https://user:pass@makerworld.com/models/123',
    'https://makerworld.com:8443/models/123',
    'https://127.0.0.1/models/123',
    'https://makerworld.com/collections/123',
  ])('rejects source %s', (url) => {
    expect(() => parseMakerWorldUrl(url)).toThrow()
  })
  it('normalizes user-entered own-account cookie values', () => {
    expect(normalizeMakerWorldCookie('Cookie: other=1; token=abc.def-ghi; foo=2')).toBe(
      'abc.def-ghi',
    )
    expect(normalizeMakerWorldCookie('abc.def-ghi')).toBe('abc.def-ghi')
    for (const value of ['token=ok\r\nX-Evil: yes', 'other=secret', 'token=', 'a'.repeat(16_385)])
      expect(() => normalizeMakerWorldCookie(value)).toThrow()
  })
  it.each([
    'https://api.bambulab.com.evil.test/file',
    'https://127.0.0.1/file',
    'http://makerworld.bblmw.com/file',
    'https://makerworld.bblmw.com:8443/file',
    'https://user:pass@makerworld.bblmw.com/file',
    'https://anything.amazonaws.com/file',
  ])('rejects remote %s', (url) => {
    expect(() => validateMakerWorldRemoteUrl(url)).toThrow()
  })
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.0.22',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '198.18.0.1',
    '224.0.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
    '2002:7f00:1::',
  ])('rejects non-public address %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false)
  })
  it('allows ordinary public IPv4 and IPv6', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true)
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true)
  })
})
