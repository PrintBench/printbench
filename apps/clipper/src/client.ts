import { parseModelSourceUrl } from '../../../packages/core/src/import/source-router'

export interface Connection {
  id: string
  origin: string
  token: string
}

export interface Library {
  id: string
  name: string
  backend: 'local' | 's3'
}

export interface ImportInput {
  libraryId: string
  url: string
}

export interface ImportStatus {
  state: 'queued' | 'importing' | 'complete' | 'failed'
  publicId: string | null
  error: string | null
}

export function installationOrigin(address: string): string {
  const url = new URL(address.trim())
  const loopback = ['localhost', '127.0.0.1', '[::1]']
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback.includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Enter the PrintBench server address. Use HTTPS or a local HTTP address.')
  }
  return url.origin
}

export function hostPermission(origin: string) {
  const url = new URL(installationOrigin(origin))
  return { origins: [url.protocol + '//' + url.hostname + '/*'] }
}

export function modelSource(url: string | undefined) {
  try {
    return url ? parseModelSourceUrl(url) : null
  } catch {
    return null
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function request<T>(connection: Connection, path: string, input?: ImportInput): Promise<T> {
  const origin = installationOrigin(connection.origin)
  let response: Response
  try {
    response = await fetch(origin + '/api/v1/clipper' + path, {
      method: input ? 'POST' : 'GET',
      headers: {
        Authorization: 'Bearer ' + connection.token,
        ...(input ? { 'Content-Type': 'application/json' } : {}),
      },
      body: input ? JSON.stringify(input) : undefined,
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
    })
  } catch {
    throw new Error('Could not reach PrintBench. Check the server address and try again.')
  }
  const data = await response.json().catch(() => null)
  if (!response.ok || !data) {
    let message =
      typeof data?.error === 'string' ? data.error : 'Check the PrintBench server and try again.'
    if (response.status === 401) {
      message =
        'The connection token is invalid, expired, or revoked. Generate a new token in PrintBench Account settings, then disconnect and reconnect in the extension.'
    } else if (response.status === 403) {
      message =
        'This account needs upload access. Ask a PrintBench administrator to check your role.'
    } else if (response.status === 404 && path === '/libraries') {
      message = 'The browser clipper API was not found. Check the address and upgrade PrintBench.'
    }
    throw new ApiError(response.status, message)
  }
  return data as T
}

export async function fetchLibraries(connection: Connection): Promise<Library[]> {
  const data = await request<{ libraries: Library[] }>(connection, '/libraries')
  if (!Array.isArray(data.libraries))
    throw new Error('The server did not return a PrintBench library list.')
  return data.libraries
}

export function submitImport(connection: Connection, input: ImportInput) {
  return request<{ id: string }>(connection, '/imports', input)
}

export function fetchImport(connection: Connection, id: string) {
  return request<ImportStatus>(connection, '/imports/' + encodeURIComponent(id))
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong. Try again.'
}
