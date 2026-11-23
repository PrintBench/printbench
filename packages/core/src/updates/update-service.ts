import { z } from 'zod'

/**
 * Is a newer PrintBench released than the one running?
 *
 * Self-hosted installs have nobody watching a release feed for them, so an
 * instance can sit months behind a security fix without anyone noticing. This
 * asks GitHub for the latest published release and compares it with the
 * version baked into the build.
 *
 * Three deliberate constraints:
 *
 *  - It is a read of one public, unauthenticated endpoint. Nothing about the
 *    library, the instance or its users is sent - not even in the User-Agent.
 *  - It is cached in memory with a long TTL, so polling the activity feed
 *    every few seconds cannot turn into a request per poll, and a failing
 *    network cannot turn into a request storm.
 *  - It never nags about a version it cannot parse. A fork, a dirty build or a
 *    tag scheme we do not understand is silence, not a false "update
 *    available" that sends someone looking for a release that does not exist.
 *
 * Admins who would rather their instance talked to nothing can turn the whole
 * check off (`updateChecks` in settings).
 */

/** The public release feed. Unauthenticated, and excludes drafts and prereleases. */
export const RELEASE_API_URL = 'https://api.github.com/repos/PrintBench/printbench/releases/latest'
/** Where someone is sent to read the notes and download. */
export const RELEASE_PAGE_URL = 'https://github.com/PrintBench/printbench/releases/latest'

/** How long a successful answer is reused. Releases are not minutes apart. */
export const UPDATE_CHECK_TTL_MS = 6 * 60 * 60 * 1000
/** A failure is retried sooner than a success is refreshed, but not much sooner. */
export const UPDATE_FAILURE_TTL_MS = 15 * 60 * 1000

const REQUEST_TIMEOUT_MS = 5000
/** A release payload is a few kilobytes. This is slack, not a target. */
const MAX_RESPONSE_BYTES = 256 * 1024

export interface UpdateStatus {
  /** The version this build reports, verbatim - `unknown` when unset. */
  currentVersion: string
  /** The newest published release, or null if that has never been read. */
  latestVersion: string | null
  /** Release notes for `latestVersion`. Always a github.com URL. */
  releaseUrl: string | null
  /** When `latestVersion` was last read successfully. */
  checkedAt: string | null
  /** True only when both versions parsed and the released one is newer. */
  updateAvailable: boolean
  /** The most recent attempt failed. Any version above is the last good read. */
  failed: boolean
}

export interface Version {
  major: number
  minor: number
  patch: number
  /** SemVer prerelease identifiers, empty for a final release. */
  prerelease: (string | number)[]
}

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:[0-9A-Za-z-]+)(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/** Parses `1.2.3`, `v1.2.3` or `1.2.3-rc.1`. Anything else is null, never a throw. */
export function parseVersion(value: string | null | undefined): Version | null {
  const match = SEMVER.exec(
    String(value ?? '')
      .trim()
      .replace(/^v/, ''),
  )
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: (match[4]?.split('.') ?? []).map((part) =>
      /^(0|[1-9]\d*)$/.test(part) ? Number(part) : part,
    ),
  }
}

/** SemVer precedence: numeric identifiers rank below alphanumeric ones. */
export function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  // A prerelease precedes the release it leads up to: 1.0.0-rc.1 < 1.0.0.
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0
    return a.prerelease.length === 0 ? 1 : -1
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const left = a.prerelease[index]
    const right = b.prerelease[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    if (left === right) continue
    if (typeof left === 'number' && typeof right === 'number') return left < right ? -1 : 1
    if (typeof left === 'number') return -1
    if (typeof right === 'number') return 1
    return left < right ? -1 : 1
  }
  return 0
}

/**
 * Is `candidate` a version worth upgrading to from `installed`?
 *
 * False whenever either side is unparseable. Being quiet about a version we do
 * not understand is better than telling someone to install something that may
 * not be ahead of what they are already running.
 */
export function isNewerVersion(
  candidate: string | null | undefined,
  installed: string | null | undefined,
): boolean {
  const latest = parseVersion(candidate)
  const current = parseVersion(installed)
  if (!latest || !current) return false
  return compareVersions(latest, current) > 0
}

const releaseSchema = z.object({
  tag_name: z.string().max(256),
  html_url: z.string().max(2048).nullish(),
  draft: z.boolean().nullish(),
  prerelease: z.boolean().nullish(),
})

export interface LatestRelease {
  version: string
  releaseUrl: string
}

/**
 * Reads the latest published release.
 *
 * The URL in the payload is checked rather than trusted: it is rendered as a
 * link in the admin UI, and a link taken from a remote document should never
 * be able to point anywhere it likes.
 */
export async function fetchLatestRelease(
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<LatestRelease> {
  const response = await fetchImpl(RELEASE_API_URL, {
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      // GitHub requires a User-Agent. It names the software and nothing else:
      // not the version, not the instance, not who is asking.
      'user-agent': 'PrintBench',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Release feed returned ${response.status}`)
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES)
    throw new Error('Release feed response is too large')
  const body = await response.text()
  if (body.length > MAX_RESPONSE_BYTES) throw new Error('Release feed response is too large')

  const release = releaseSchema.parse(JSON.parse(body))
  if (release.draft || release.prerelease) throw new Error('Latest release is not published')
  if (!parseVersion(release.tag_name)) throw new Error('Unrecognised release tag')

  let releaseUrl = RELEASE_PAGE_URL
  try {
    const url = new URL(release.html_url ?? '')
    if (url.protocol === 'https:' && url.hostname === 'github.com') releaseUrl = url.toString()
  } catch {
    // Keep the canonical releases page.
  }
  return { version: release.tag_name.trim().replace(/^v/, ''), releaseUrl }
}

interface Cached {
  status: UpdateStatus
  /** When the attempt behind `status` was made, successful or not. */
  attemptedAt: number
}

let cached: Cached | null = null
let inFlight: Promise<UpdateStatus> | null = null

export interface UpdateCheckOptions {
  /** Usually `process.env.PB_VERSION`. */
  currentVersion: string | undefined
  now?: number
  ttlMs?: number
  failureTtlMs?: number
  fetchImpl?: typeof fetch
}

function isFresh(entry: Cached, options: UpdateCheckOptions, now: number): boolean {
  const ttl = entry.status.failed
    ? (options.failureTtlMs ?? UPDATE_FAILURE_TTL_MS)
    : (options.ttlMs ?? UPDATE_CHECK_TTL_MS)
  // A clock that jumped backwards must not pin a stale answer in place.
  return now >= entry.attemptedAt && now - entry.attemptedAt < ttl
}

function withCurrent(status: UpdateStatus, currentVersion: string): UpdateStatus {
  // The cache outlives a code reload in development, so the comparison is
  // re-derived against the version actually running.
  return {
    ...status,
    currentVersion,
    updateAvailable: isNewerVersion(status.latestVersion, currentVersion),
  }
}

/**
 * The update status, reading the release feed only when the cache is stale.
 *
 * Concurrent callers share one request: the activity feed is polled by every
 * open tab, and they must not each open a connection to GitHub.
 */
export async function checkForUpdate(
  options: UpdateCheckOptions & { force?: boolean },
): Promise<UpdateStatus> {
  const currentVersion = options.currentVersion?.trim() || 'unknown'
  const now = options.now ?? Date.now()
  if (!options.force && cached && isFresh(cached, options, now))
    return withCurrent(cached.status, currentVersion)
  if (inFlight) return withCurrent(await inFlight, currentVersion)

  const previous = cached?.status
  inFlight = fetchLatestRelease(options.fetchImpl)
    .then<UpdateStatus>((release) => ({
      currentVersion,
      latestVersion: release.version,
      releaseUrl: release.releaseUrl,
      checkedAt: new Date(now).toISOString(),
      updateAvailable: isNewerVersion(release.version, currentVersion),
      failed: false,
    }))
    .catch<UpdateStatus>(() => ({
      // A failed check keeps the last version it did read: discarding it would
      // make an instance that has lost its network look up to date.
      currentVersion,
      latestVersion: previous?.latestVersion ?? null,
      releaseUrl: previous?.releaseUrl ?? null,
      checkedAt: previous?.checkedAt ?? null,
      updateAvailable: isNewerVersion(previous?.latestVersion, currentVersion),
      failed: true,
    }))
    .then((status) => {
      cached = { status, attemptedAt: now }
      return status
    })
    .finally(() => {
      inFlight = null
    })
  return withCurrent(await inFlight, currentVersion)
}

/**
 * The cached status without ever waiting on the network, refreshing it in the
 * background when it is stale.
 *
 * This is what the activity feed uses. A poll answered in a few milliseconds
 * today must not start taking five seconds because GitHub is slow, so the
 * first caller after a restart gets null and the next one gets an answer.
 */
export function peekUpdateStatus(options: UpdateCheckOptions): UpdateStatus | null {
  const currentVersion = options.currentVersion?.trim() || 'unknown'
  const now = options.now ?? Date.now()
  if (!cached || !isFresh(cached, options, now))
    // Fire and forget: a failure is recorded in the cached status, not thrown
    // into whichever request happened to notice the staleness.
    void checkForUpdate(options).catch(() => undefined)
  return cached ? withCurrent(cached.status, currentVersion) : null
}

/** Test seam, and the way a forced check starts from nothing. */
export function resetUpdateCache(): void {
  cached = null
}
