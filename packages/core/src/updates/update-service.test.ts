import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RELEASE_API_URL,
  RELEASE_PAGE_URL,
  checkForUpdate,
  compareVersions,
  fetchLatestRelease,
  isNewerVersion,
  parseVersion,
  peekUpdateStatus,
  resetUpdateCache,
} from './update-service'

function release(body: unknown, init: ResponseInit = {}): typeof fetch {
  return vi.fn(async () => Response.json(body, { status: 200, ...init })) as unknown as typeof fetch
}

afterEach(() => {
  resetUpdateCache()
})

describe('version parsing', () => {
  it('accepts the tag shapes releases actually use', () => {
    expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] })
    expect(parseVersion(' 0.7.6 ')).toEqual({ major: 0, minor: 7, patch: 6, prerelease: [] })
    expect(parseVersion('1.0.0-rc.1')?.prerelease).toEqual(['rc', 1])
    expect(parseVersion('1.0.0+build.5')?.prerelease).toEqual([])
  })

  it('refuses anything it cannot compare', () => {
    for (const value of ['', 'unknown', 'main', '1.2', '1.2.3.4', '01.2.3', null, undefined])
      expect(parseVersion(value)).toBeNull()
  })
})

describe('version comparison', () => {
  it('orders releases by precedence', () => {
    const order = ['0.7.6', '0.8.0-rc.1', '0.8.0-rc.2', '0.8.0-rc.10', '0.8.0', '1.0.0']
    for (let index = 1; index < order.length; index++)
      expect(compareVersions(parseVersion(order[index]!)!, parseVersion(order[index - 1]!)!)).toBe(
        1,
      )
  })

  it('ranks numeric prerelease identifiers below alphanumeric ones', () => {
    expect(compareVersions(parseVersion('1.0.0-1')!, parseVersion('1.0.0-alpha')!)).toBe(-1)
    expect(compareVersions(parseVersion('1.0.0-alpha')!, parseVersion('1.0.0-alpha.1')!)).toBe(-1)
  })

  /*
   * A build we cannot place is reported as "no update". Telling someone to
   * install a release that may be behind what they run is worse than silence.
   */
  it('never claims an update when either version is unparseable', () => {
    expect(isNewerVersion('1.0.0', 'unknown')).toBe(false)
    expect(isNewerVersion('nightly', '0.7.6')).toBe(false)
    expect(isNewerVersion('0.8.0', '0.7.6')).toBe(true)
    expect(isNewerVersion('0.7.6', '0.8.0')).toBe(false)
    expect(isNewerVersion('0.7.6', '0.7.6')).toBe(false)
  })
})

describe('reading the release feed', () => {
  it('reads the published tag and its notes', async () => {
    const fetchImpl = release({
      tag_name: 'v0.9.0',
      html_url: 'https://github.com/PrintBench/printbench/releases/tag/v0.9.0',
    })
    await expect(fetchLatestRelease(fetchImpl)).resolves.toEqual({
      version: '0.9.0',
      releaseUrl: 'https://github.com/PrintBench/printbench/releases/tag/v0.9.0',
    })
    expect(fetchImpl).toHaveBeenCalledWith(RELEASE_API_URL, expect.anything())
  })

  // The payload is a remote document, and this URL becomes a link in the admin UI.
  it('refuses a release link that points off github.com', async () => {
    await expect(
      fetchLatestRelease(release({ tag_name: 'v0.9.0', html_url: 'https://evil.example/pwn' })),
    ).resolves.toMatchObject({ releaseUrl: RELEASE_PAGE_URL })
    await expect(
      fetchLatestRelease(release({ tag_name: 'v0.9.0', html_url: 'javascript:alert(1)' })),
    ).resolves.toMatchObject({ releaseUrl: RELEASE_PAGE_URL })
  })

  it('rejects drafts, prereleases and tags it cannot read', async () => {
    await expect(fetchLatestRelease(release({ tag_name: 'v1.0.0', draft: true }))).rejects.toThrow()
    await expect(
      fetchLatestRelease(release({ tag_name: 'v1.0.0-rc.1', prerelease: true })),
    ).rejects.toThrow()
    await expect(fetchLatestRelease(release({ tag_name: 'nightly' }))).rejects.toThrow()
  })

  it('treats an error response as a failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('rate limited', { status: 403 }))
    await expect(fetchLatestRelease(fetchImpl as unknown as typeof fetch)).rejects.toThrow()
  })
})

describe('checking for an update', () => {
  it('reports a newer release once', async () => {
    const fetchImpl = release({ tag_name: 'v0.9.0' })
    const status = await checkForUpdate({ currentVersion: '0.7.6', fetchImpl, now: 1000 })
    expect(status).toMatchObject({
      currentVersion: '0.7.6',
      latestVersion: '0.9.0',
      updateAvailable: true,
      failed: false,
      checkedAt: new Date(1000).toISOString(),
    })

    // Every open tab polls the activity feed; the feed must not become traffic.
    await checkForUpdate({ currentVersion: '0.7.6', fetchImpl, now: 2000 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('refreshes once the answer is stale, and on demand', async () => {
    const fetchImpl = release({ tag_name: 'v0.9.0' })
    await checkForUpdate({ currentVersion: '0.7.6', fetchImpl, now: 0 })
    await checkForUpdate({ currentVersion: '0.7.6', fetchImpl, now: 0, force: true })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    await checkForUpdate({ currentVersion: '0.7.6', fetchImpl, now: 10, ttlMs: 5 })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('keeps the last version it read when a later check fails', async () => {
    await checkForUpdate({
      currentVersion: '0.7.6',
      fetchImpl: release({ tag_name: 'v0.9.0' }),
      now: 0,
    })
    const offline = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }) as unknown as typeof fetch
    const status = await checkForUpdate({
      currentVersion: '0.7.6',
      fetchImpl: offline,
      force: true,
    })
    expect(status).toMatchObject({
      latestVersion: '0.9.0',
      updateAvailable: true,
      failed: true,
      checkedAt: new Date(0).toISOString(),
    })
  })

  it('reports no update when the instance is current', async () => {
    const status = await checkForUpdate({
      currentVersion: 'v0.9.0',
      fetchImpl: release({ tag_name: 'v0.9.0' }),
    })
    expect(status.updateAvailable).toBe(false)
  })

  it('calls an unparseable build version "unknown" and stays quiet', async () => {
    const status = await checkForUpdate({
      currentVersion: undefined,
      fetchImpl: release({ tag_name: 'v0.9.0' }),
    })
    expect(status).toMatchObject({ currentVersion: 'unknown', updateAvailable: false })
  })
})

describe('peeking without waiting', () => {
  it('answers from the cache and refreshes in the background', async () => {
    const fetchImpl = release({ tag_name: 'v0.9.0' })
    expect(peekUpdateStatus({ currentVersion: '0.7.6', fetchImpl, now: 0 })).toBeNull()
    await vi.waitFor(() =>
      expect(peekUpdateStatus({ currentVersion: '0.7.6', fetchImpl, now: 0 })).toMatchObject({
        latestVersion: '0.9.0',
        updateAvailable: true,
      }),
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('never rejects when the network is down', async () => {
    const offline = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(peekUpdateStatus({ currentVersion: '0.7.6', fetchImpl: offline })).toBeNull()
    await vi.waitFor(() =>
      expect(peekUpdateStatus({ currentVersion: '0.7.6', fetchImpl: offline })).toMatchObject({
        failed: true,
        updateAvailable: false,
      }),
    )
  })
})
