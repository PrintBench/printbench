import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { createWriteStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { isPublicAddress } from './makerworld-network'
import type { ExternalSourceProvider } from './source-provider-types'

export interface SourceRequest {
  method?: 'GET' | 'POST'
  body?: string
  headers?: Record<string, string>
  maxBytes: number
  timeoutMs: number
}
export interface SourceResponse {
  status: number
  body: Buffer
}

/** Provider-specific HTTPS destinations. Never a general-purpose remote fetcher. */
export function validateSourceRemoteUrl(
  provider: ExternalSourceProvider,
  value: string,
  api = false,
): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Invalid source remote URL')
  }
  const allowed =
    provider === 'printables'
      ? api
        ? url.hostname === 'api.printables.com' && ['/graphql', '/graphql/'].includes(url.pathname)
        : ['files.printables.com', 'media.printables.com'].includes(url.hostname)
      : api
        ? url.hostname === 'api.thingiverse.com'
        : url.hostname === 'cdn.thingiverse.com'
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowed)
    throw new Error('Source remote host is not allowed')
  return url
}

async function openResponse(url: URL, options: SourceRequest) {
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes <= 0 ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    (options.body?.length ?? 0) > 64 * 1024
  )
    throw new Error('Invalid source request limits')
  const started = Date.now()
  let dnsTimer: ReturnType<typeof setTimeout> | undefined
  const addresses = await Promise.race([
    lookup(url.hostname, { all: true }),
    new Promise<never>((_resolve, reject) => {
      dnsTimer = setTimeout(
        () => reject(new Error('Source DNS lookup timed out')),
        options.timeoutMs,
      )
    }),
  ]).finally(() => clearTimeout(dnsTimer))
  if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address)))
    throw new Error('Source remote address is not public')
  const address = addresses[0]!
  return new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    const req = request(
      url,
      {
        method: options.method ?? 'GET',
        agent: false,
        headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', ...options.headers },
        lookup: (_hostname, _options, callback) => {
          if (_options.all) callback(null, [address])
          else callback(null, address.address, address.family)
        },
      },
      (response) => {
        const size = Number(response.headers['content-length'])
        if (Number.isFinite(size) && size > options.maxBytes) {
          response.destroy()
          reject(new Error('Source response exceeds the size limit'))
        } else resolve(response)
      },
    )
    const timer = setTimeout(
      () => req.destroy(new Error('Source request timed out')),
      Math.max(1, options.timeoutMs - (Date.now() - started)),
    )
    req.on('close', () => clearTimeout(timer))
    req.on('error', () => reject(new Error('Source network request failed')))
    req.end(options.body)
  })
}

/** API responses never follow redirects, so account authorization cannot escape. */
export async function requestSourceJson(
  provider: ExternalSourceProvider,
  value: string,
  options: SourceRequest,
): Promise<SourceResponse> {
  const url = validateSourceRemoteUrl(provider, value, true)
  if (options.method && !['GET', 'POST'].includes(options.method))
    throw new Error('Source method is not allowed')
  if ((options.method ?? 'GET') === 'POST' && provider !== 'printables')
    throw new Error('Source method is not allowed')
  const response = await openResponse(url, options)
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of response) {
      const buffer = Buffer.from(chunk)
      size += buffer.length
      if (size > options.maxBytes) throw new Error('Source response exceeds the size limit')
      chunks.push(buffer)
    }
  } catch {
    response.destroy()
    throw new Error('Could not read source response within the limits')
  }
  return { status: response.statusCode ?? 502, body: Buffer.concat(chunks) }
}

/** The only authenticated file hop is Thingiverse's fixed API download endpoint. */
export async function downloadSourceFile(
  provider: ExternalSourceProvider,
  value: string,
  destination: string,
  options: { maxBytes?: number; timeoutMs?: number; token?: string } = {},
): Promise<number> {
  const maxBytes = options.maxBytes ?? 512 * 1024 * 1024
  const timeoutMs = options.timeoutMs ?? 120_000
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('Invalid source remote URL')
  }
  const started = Date.now()
  const apiDownload = provider === 'thingiverse' && parsed.hostname === 'api.thingiverse.com'
  const url = validateSourceRemoteUrl(provider, value, apiDownload)
  if (apiDownload && !/^\/files\/[1-9]\d{0,15}\/download$/.test(url.pathname))
    throw new Error('Unsupported source download endpoint')
  if (apiDownload && (!options.token || !/^[A-Za-z0-9._~-]{1,16384}$/.test(options.token)))
    throw new Error('Thingiverse access token is required')
  let response = await openResponse(url, {
    maxBytes,
    timeoutMs,
    headers: {
      Accept: 'application/octet-stream',
      ...(apiDownload ? { Authorization: `Bearer ${options.token}` } : {}),
    },
  })
  if (apiDownload && [301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
    const location = response.headers.location
    response.destroy()
    if (!location) throw new Error('Source download did not provide a location')
    const remote = validateSourceRemoteUrl(provider, new URL(location, url).href)
    response = await openResponse(remote, {
      maxBytes,
      timeoutMs: Math.max(1, timeoutMs - (Date.now() - started)),
      headers: { Accept: 'application/octet-stream' },
    })
  }
  if (response.statusCode !== 200) {
    response.destroy()
    throw new Error('Source file download was refused or expired; resolve the model again')
  }
  let size = 0
  let created = false
  const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 })
  output.once('open', () => {
    created = true
  })
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length
      callback(size > maxBytes ? new Error('Source file exceeds the size limit') : null, chunk)
    },
  })
  try {
    await pipeline(response, limiter, output)
    return size
  } catch {
    if (created) await unlink(destination).catch(() => undefined)
    throw new Error('Source file download failed')
  }
}
