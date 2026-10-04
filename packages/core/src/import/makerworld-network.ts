import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { isIP } from 'node:net'
import { createWriteStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export interface MakerWorldRequest {
  headers?: Record<string, string>
  method?: 'GET' | 'POST'
  body?: string
  maxBytes: number
  timeoutMs: number
}

export interface MakerWorldResponse {
  status: number
  body: Buffer
  setCookies?: string[]
}

/** A narrow outbound policy, not a general URL fetcher. */
export function validateMakerWorldRemoteUrl(value: string, api = false): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Invalid MakerWorld remote URL')
  }
  const host = url.hostname
  const allowed = api
    ? host === 'api.bambulab.com'
    : ['makerworld.bblmw.com', 'public-cdn.bblmw.com', 'public-cdn.bambulab.com'].includes(host) ||
      /^(?:[a-z0-9-]+\.)?s3[.-][a-z0-9-]+\.amazonaws\.com$/.test(host)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowed) {
    throw new Error('MakerWorld remote host is not allowed')
  }
  return url
}

/** Reject special-use ranges; only globally routed IPv6 unicast is accepted. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number)
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    )
  }
  if (isIP(address) !== 6) return false
  const lower = address.toLowerCase()
  return (
    /^[23][0-9a-f]{3}:/.test(lower) &&
    !lower.startsWith('2001:') &&
    !lower.startsWith('2002:') &&
    !lower.startsWith('3fff:')
  )
}

async function openResponse(url: URL, options: MakerWorldRequest) {
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes <= 0 ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0
  ) {
    throw new Error('Invalid MakerWorld request limits')
  }
  // Pin the validated lookup in the connection itself so DNS cannot change
  // between the safety check and the actual request.
  let dnsTimer: ReturnType<typeof setTimeout> | undefined
  const started = Date.now()
  const addresses = await Promise.race([
    lookup(url.hostname, { all: true }),
    new Promise<never>((_resolve, reject) => {
      dnsTimer = setTimeout(
        () => reject(new Error('MakerWorld DNS lookup timed out')),
        options.timeoutMs,
      )
    }),
  ]).finally(() => clearTimeout(dnsTimer))
  if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new Error('MakerWorld remote address is not public')
  }
  const address = addresses[0]!
  return new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    const req = request(
      url,
      {
        method: options.method ?? 'GET',
        agent: false,
        headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', ...options.headers },
        lookup: (_hostname, _options, callback) => {
          // Node requests all answers in recent releases; preserve that contract.
          if (_options.all) callback(null, [address])
          else callback(null, address.address, address.family)
        },
      },
      (response) => {
        const size = Number(response.headers['content-length'])
        if (Number.isFinite(size) && size > options.maxBytes) {
          response.destroy()
          reject(new Error('MakerWorld response exceeds the size limit'))
        } else resolve(response)
      },
    )
    const timer = setTimeout(
      () => req.destroy(new Error('MakerWorld request timed out')),
      Math.max(1, options.timeoutMs - (Date.now() - started)),
    )
    req.on('close', () => clearTimeout(timer))
    req.on('error', () => reject(new Error('MakerWorld network request failed')))
    req.end(options.body)
  })
}

/** No redirects: credentials can never follow a Location header. */
export async function requestMakerWorldJson(
  url: string,
  options: MakerWorldRequest,
): Promise<MakerWorldResponse> {
  return readJsonResponse(
    await openResponse(validateMakerWorldRemoteUrl(url, true), options),
    options,
  )
}

/** Auth has its own exact URL allowlist; credentials cannot go to arbitrary web/CDN paths. */
export async function requestBambuAuthJson(
  url: string,
  options: MakerWorldRequest,
): Promise<MakerWorldResponse> {
  const allowed = [
    'https://api.bambulab.com/v1/user-service/user/login',
    'https://api.bambulab.com/v1/design-user-service/my/preference',
    'https://bambulab.com/api/csrf',
    'https://bambulab.com/api/sign-in/tfa',
  ]
  if (!allowed.includes(url)) throw new Error('Bambu sign-in endpoint is not allowed')
  if (options.body && (options.method !== 'POST' || Buffer.byteLength(options.body) > 8192)) {
    throw new Error('Invalid Bambu sign-in request')
  }
  return readJsonResponse(await openResponse(new URL(url), options), options)
}

async function readJsonResponse(
  response: import('node:http').IncomingMessage,
  options: MakerWorldRequest,
): Promise<MakerWorldResponse> {
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of response) {
      const buffer = Buffer.from(chunk)
      size += buffer.length
      if (size > options.maxBytes) throw new Error('MakerWorld response exceeds the size limit')
      chunks.push(buffer)
    }
  } catch {
    response.destroy()
    throw new Error('Could not read MakerWorld response within the limits')
  }
  return {
    status: response.statusCode ?? 502,
    body: Buffer.concat(chunks),
    setCookies: response.headers['set-cookie'],
  }
}

/** Worker-only streaming download. The caller supplies a new staging path. */
export async function downloadMakerWorldFile(
  url: string,
  destination: string,
  options: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<number> {
  const maxBytes = options.maxBytes ?? 512 * 1024 * 1024
  const response = await openResponse(validateMakerWorldRemoteUrl(url), {
    maxBytes,
    timeoutMs: options.timeoutMs ?? 120_000,
    headers: { Accept: 'application/octet-stream' },
  })
  if (response.statusCode !== 200) {
    response.destroy()
    throw new Error('MakerWorld file download was refused or expired; resolve the model again')
  }
  let size = 0
  const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 })
  let created = false
  output.once('open', () => {
    created = true
  })
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length
      callback(size > maxBytes ? new Error('MakerWorld file exceeds the size limit') : null, chunk)
    },
  })
  try {
    await pipeline(response, limiter, output)
    return size
  } catch {
    if (created) await unlink(destination).catch(() => undefined)
    throw new Error('MakerWorld file download failed')
  }
}
