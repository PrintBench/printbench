/**
 * Sending a sliced file to a networked printer.
 *
 * Three protocols, all plain HTTP with an API key:
 *
 *   octoprint  POST /api/files/local        X-Api-Key
 *   moonraker  POST /server/files/upload    X-Api-Key (often none on a LAN)
 *   prusalink  PUT  /api/v1/files/usb/...   X-Api-Key
 *
 * Bambu is deliberately absent. Its printers have no simple HTTP upload —
 * pushing to one means FTPS plus MQTT with LAN mode enabled and an access code,
 * which is a week of work and the flakiest path of the lot. Handing the file to
 * Bambu Studio, which already knows how to talk to them, is both simpler and
 * more reliable. See slicers.ts.
 */

export type PrintHostProtocol = 'octoprint' | 'moonraker' | 'prusalink'

export interface PrintHostConfig {
  id: string
  name: string
  protocol: PrintHostProtocol
  /** Base URL, e.g. http://octopi.local */
  endpoint: string
  apiKey?: string | null
}

export interface SendResult {
  ok: boolean
  error?: string
  /** Path or name the printer reported for the stored file. */
  remotePath?: string
}

export interface HostStatus {
  ok: boolean
  /** Reported by the printer, when it says. */
  version?: string
  state?: string
  error?: string
}

/** Only sliced output can be sent; a mesh means nothing to a printer. */
export const SENDABLE_EXTENSIONS = ['gcode', 'bgcode', 'sl1', 'sl1s', 'ctb', '3mf'] as const

export function canSendToPrinter(extension: string): boolean {
  return (SENDABLE_EXTENSIONS as readonly string[]).includes(
    extension.toLowerCase().replace(/^\./, ''),
  )
}

/** Ten seconds is generous for a status probe on a LAN and short enough to fail fast. */
const PROBE_TIMEOUT_MS = 10_000
/** Uploads are slow on a Pi; a large gcode over wifi legitimately takes minutes. */
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000

function baseUrl(endpoint: string): string {
  return endpoint.replace(/\/+$/, '')
}

/**
 * Rejects an endpoint that is not a plain http(s) URL.
 *
 * The endpoint is admin-configured, but it is still user input that becomes an
 * outbound request from the server — a file:// or similar would be a way to
 * make the worker read something it should not.
 */
export function isValidEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export async function probeHost(
  host: PrintHostConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<HostStatus> {
  if (!isValidEndpoint(host.endpoint)) {
    return { ok: false, error: 'Endpoint must be an http or https URL.' }
  }

  const base = baseUrl(host.endpoint)
  const headers: Record<string, string> = {}
  if (host.apiKey) headers['x-api-key'] = host.apiKey

  const url =
    host.protocol === 'moonraker'
      ? `${base}/printer/info`
      : host.protocol === 'prusalink'
        ? `${base}/api/version`
        : `${base}/api/version`

  try {
    const response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })

    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: 'The printer rejected the API key.' }
    }
    if (!response.ok) {
      return { ok: false, error: `Printer replied ${response.status}.` }
    }

    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
    const result = (data.result ?? data) as Record<string, unknown>

    return {
      ok: true,
      version: String(result.software_version ?? result.server ?? result.text ?? '') || undefined,
      state: String(result.state ?? '') || undefined,
    }
  } catch (error) {
    return { ok: false, error: describeNetworkError(error, host.endpoint) }
  }
}

/**
 * Uploads a sliced file, optionally starting the print.
 *
 * Takes bytes rather than a stream because all three APIs want multipart, and
 * sliced output is small — a large gcode is tens of megabytes, not gigabytes.
 * That is a different situation from the mesh downloads, which do stream.
 */
export async function sendToPrinter(
  host: PrintHostConfig,
  /*
   * The buffer type is pinned: an unparameterised Uint8Array widens to
   * ArrayBufferLike, which admits SharedArrayBuffer and is therefore not a
   * valid fetch body.
   */
  file: { filename: string; data: Uint8Array<ArrayBuffer> },
  options: { startPrint?: boolean } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  if (!isValidEndpoint(host.endpoint)) {
    return { ok: false, error: 'Endpoint must be an http or https URL.' }
  }
  if (!canSendToPrinter(file.filename.split('.').pop() ?? '')) {
    return { ok: false, error: 'Only sliced files can be sent to a printer.' }
  }

  const base = baseUrl(host.endpoint)
  const headers: Record<string, string> = {}
  if (host.apiKey) headers['x-api-key'] = host.apiKey

  try {
    switch (host.protocol) {
      case 'octoprint':
        return await uploadMultipart(
          fetchImpl,
          `${base}/api/files/local`,
          headers,
          file,
          options.startPrint ? { print: 'true' } : {},
        )

      case 'moonraker':
        return await uploadMultipart(
          fetchImpl,
          `${base}/server/files/upload`,
          headers,
          file,
          // Moonraker names the flag differently and wants it as a string.
          options.startPrint ? { print: 'true' } : { print: 'false' },
        )

      case 'prusalink': {
        // PrusaLink is a PUT of the raw bytes, not multipart.
        const response = await fetchImpl(
          `${base}/api/v1/files/usb/${encodeURIComponent(file.filename)}`,
          {
            method: 'PUT',
            headers: {
              ...headers,
              'content-type': 'application/octet-stream',
              // Without this the file is stored but never started.
              'print-after-upload': options.startPrint ? '1' : '0',
              overwrite: '1',
            },
            body: file.data,
            signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
          },
        )
        if (!response.ok) {
          return { ok: false, error: await describeHttpError(response) }
        }
        return { ok: true, remotePath: `usb/${file.filename}` }
      }
    }
  } catch (error) {
    return { ok: false, error: describeNetworkError(error, host.endpoint) }
  }
}

async function uploadMultipart(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  file: { filename: string; data: Uint8Array<ArrayBuffer> },
  fields: Record<string, string>,
): Promise<SendResult> {
  const form = new FormData()
  form.append('file', new Blob([file.data]), file.filename)
  for (const [key, value] of Object.entries(fields)) form.append(key, value)

  const response = await fetchImpl(url, {
    method: 'POST',
    // Content-Type is deliberately not set: fetch adds it with the multipart
    // boundary, and overriding it produces a body the server cannot parse.
    headers,
    body: form,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  })

  if (!response.ok) return { ok: false, error: await describeHttpError(response) }

  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
  const files = data.files as Record<string, { path?: string; name?: string }> | undefined
  return {
    ok: true,
    remotePath: files?.local?.path ?? files?.local?.name ?? file.filename,
  }
}

async function describeHttpError(response: Response): Promise<string> {
  if (response.status === 401 || response.status === 403) {
    return 'The printer rejected the API key.'
  }
  if (response.status === 409) {
    return 'The printer is busy — it may already be printing.'
  }
  if (response.status === 404) {
    return 'The printer did not recognise that address. Check the endpoint.'
  }
  const body = await response.text().catch(() => '')
  return `Printer replied ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`
}

/**
 * Turns a network failure into something actionable.
 *
 * "fetch failed" tells someone nothing; the usual causes here are a printer
 * that is switched off or a hostname that does not resolve, and saying so
 * saves a support round trip.
 */
function describeNetworkError(error: unknown, endpoint: string): string {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return `${endpoint} did not respond. Is the printer switched on?`
  }

  const cause = (error as { cause?: NetworkCause })?.cause
  /*
   * undici reports a failed connection as a bare TypeError("fetch failed") and
   * hides the real reason on `cause`. When a host resolves to several addresses
   * it nests one level further, in an AggregateError's `errors`.
   */
  const code = cause?.code ?? cause?.errors?.find((inner) => inner.code)?.code

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `Could not resolve ${endpoint}. Check the hostname.`
  }
  if (code === 'ECONNREFUSED') {
    return `${endpoint} refused the connection. Is the service running?`
  }
  if (code === 'ECONNRESET' || code === 'EPIPE') {
    return `${endpoint} closed the connection unexpectedly.`
  }
  if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') {
    return `${endpoint} did not respond. Is the printer switched on?`
  }
  if (code === 'CERT_HAS_EXPIRED' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
    return `${endpoint} has a certificate this server will not accept.`
  }

  /*
   * Anything left over. "fetch failed" is the message in almost every case and
   * says nothing at all, so name the endpoint and pass on whatever detail the
   * cause carries — a bad port, a refused protocol — rather than the wrapper.
   */
  const detail = cause?.message ?? (error instanceof Error ? error.message : String(error))
  return detail && detail !== 'fetch failed'
    ? `Could not reach ${endpoint}: ${detail}`
    : `Could not reach ${endpoint}. Check the address and that the printer is on.`
}

interface NetworkCause {
  code?: string
  message?: string
  errors?: { code?: string; message?: string }[]
}
