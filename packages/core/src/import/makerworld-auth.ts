import { z } from 'zod'
import { normalizeMakerWorldCookie } from './makerworld'
import { requestBambuAuthJson, type MakerWorldResponse } from './makerworld-network'

// These are undocumented Bambu endpoints. Identify PrintBench honestly and never emulate Studio.
const API = 'https://api.bambulab.com'
const WEB = 'https://bambulab.com'
const headers = {
  'User-Agent': 'PrintBench (+https://github.com/PrintBench/printbench)',
  Accept: 'application/json',
}
const bounds = { maxBytes: 64 * 1024, timeoutMs: 15_000 }
export type BambuAuthRequest = typeof requestBambuAuthJson
export type BambuVerification =
  { method: 'email'; email: string } | { method: 'authenticator'; tfaKey: string }
export type BambuSignInResult =
  | { state: 'authenticated'; token: string }
  | { state: 'verification'; verification: BambuVerification }
export type MakerWorldConnectionState = 'not_connected' | 'connected' | 'expired' | 'unavailable'

export class BambuSignInError extends Error {
  constructor(
    public readonly code: 'invalid' | 'rejected' | 'blocked' | 'unavailable' | 'unsupported',
    message: string,
  ) {
    super(message)
    this.name = 'BambuSignInError'
  }
}

export function validateBambuCredentials(email: string, password: string) {
  const parsed = z
    .object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(1024) })
    .safeParse({ email, password })
  if (!parsed.success)
    throw new BambuSignInError('invalid', 'Enter your Bambu account email and password.')
  return parsed.data
}

function cookieValue(response: MakerWorldResponse, name: string): string | null {
  for (const cookie of response.setCookies ?? []) {
    const first = cookie.split(';')[0] ?? ''
    if (first.startsWith(`${name}=`)) return first.slice(name.length + 1)
  }
  return null
}

async function send(
  request: BambuAuthRequest,
  url: string,
  body?: Record<string, string>,
  extra: Record<string, string> = {},
) {
  try {
    return await request(url, {
      ...bounds,
      method: body ? 'POST' : 'GET',
      headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  } catch {
    throw new BambuSignInError(
      'unavailable',
      'Could not reach Bambu. Check the server’s internet connection and try again.',
    )
  }
}

function readResponse(response: MakerWorldResponse): Record<string, unknown> {
  const text = response.body.toString('utf8')
  if (
    [403, 418, 429].includes(response.status) ||
    /captcha|challenges\.cloudflare\.com|just a moment/i.test(text)
  ) {
    throw new BambuSignInError(
      'blocked',
      'Bambu is blocking or limiting sign-in requests. Wait a few minutes before retrying, or use the advanced cookie method.',
    )
  }
  if (response.status >= 500)
    throw new BambuSignInError(
      'unavailable',
      'Bambu is temporarily unavailable. Please try again later.',
    )
  if (response.status >= 300 && response.status < 400)
    throw new BambuSignInError(
      'unsupported',
      'Bambu redirected this request. Direct sign-in cannot continue; use the advanced cookie method.',
    )
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    // The web endpoint can issue its token in Set-Cookie with no JSON body.
    if (response.status === 200 && cookieValue(response, 'token')) return {}
    throw new BambuSignInError(
      'unsupported',
      'Bambu returned an unexpected response. Try again later or use the advanced cookie method.',
    )
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new BambuSignInError('unsupported', 'Bambu returned an unsupported sign-in response.')
  return data as Record<string, unknown>
}

function issuedToken(response: MakerWorldResponse, data: Record<string, unknown>): string | null {
  if (response.status !== 200) return null
  const value = data.accessToken ?? data.token ?? cookieValue(response, 'token')
  if (typeof value !== 'string') return null
  try {
    return normalizeMakerWorldCookie(value)
  } catch {
    throw new BambuSignInError('unsupported', 'Bambu returned an unsupported session token.')
  }
}

export async function beginBambuSignIn(
  email: string,
  password: string,
  request: BambuAuthRequest = requestBambuAuthJson,
): Promise<BambuSignInResult> {
  const credentials = validateBambuCredentials(email, password)
  const response = await send(request, `${API}/v1/user-service/user/login`, {
    account: credentials.email,
    password: credentials.password,
  })
  const data = readResponse(response)
  if (response.status !== 200)
    throw new BambuSignInError(
      'rejected',
      'Bambu did not accept this sign-in. Check your email and password. Accounts using Google or Apple sign-in may need the advanced cookie method.',
    )
  // A verification challenge always takes precedence over a token in the response.
  if (data.loginType === 'verifyCode')
    return { state: 'verification', verification: { method: 'email', email: credentials.email } }
  if (data.loginType === 'tfa' || data.tfaKey) {
    if (typeof data.tfaKey !== 'string' || !data.tfaKey || data.tfaKey.length > 1024)
      throw new BambuSignInError(
        'unsupported',
        'Bambu did not provide a usable verification challenge. Start again or use the advanced cookie method.',
      )
    return { state: 'verification', verification: { method: 'authenticator', tfaKey: data.tfaKey } }
  }
  if (data.loginType && data.loginType !== '')
    throw new BambuSignInError(
      'unsupported',
      'This Bambu sign-in method is not supported. Use the advanced cookie method.',
    )
  const token = issuedToken(response, data)
  if (!token)
    throw new BambuSignInError(
      'rejected',
      'Bambu did not accept this sign-in. Check your email and password or use the advanced cookie method.',
    )
  return { state: 'authenticated', token }
}

export async function finishBambuSignIn(
  verification: BambuVerification,
  code: string,
  request: BambuAuthRequest = requestBambuAuthJson,
): Promise<string> {
  if (!/^\d{6}$/.test(code))
    throw new BambuSignInError('invalid', 'Enter the six-digit verification code.')
  let response: MakerWorldResponse
  if (verification.method === 'email') {
    response = await send(request, `${API}/v1/user-service/user/login`, {
      account: verification.email,
      code,
    })
  } else {
    const csrf = await send(request, `${WEB}/api/csrf`)
    // Bambu's CSRF endpoint currently returns 204 plus Set-Cookie, with no JSON body.
    if (csrf.body.length > 0 || csrf.status < 200 || csrf.status >= 300) readResponse(csrf)
    const value = cookieValue(csrf, 'bbl_csrf_token')
    if (
      csrf.status < 200 ||
      csrf.status >= 300 ||
      !value ||
      value.length > 1024 ||
      !/^[A-Za-z0-9._~%=-]+$/.test(value)
    )
      throw new BambuSignInError(
        'unavailable',
        'Could not obtain Bambu’s security token. Try again later or use the advanced cookie method.',
      )
    response = await send(
      request,
      `${WEB}/api/sign-in/tfa`,
      { tfaKey: verification.tfaKey, tfaCode: code },
      { Cookie: `bbl_csrf_token=${value}`, 'x-bbl-csrf-token': value },
    )
  }
  const data = readResponse(response)
  const token = issuedToken(response, data)
  if (!token || data.loginType === 'verifyCode' || data.loginType === 'tfa')
    throw new BambuSignInError(
      'rejected',
      'Bambu did not accept that code. Try a fresh code, or start sign-in again.',
    )
  return token
}

export async function checkBambuToken(
  token: string,
  request: BambuAuthRequest = requestBambuAuthJson,
): Promise<'connected' | 'expired' | 'unavailable'> {
  try {
    const response = await send(request, `${API}/v1/design-user-service/my/preference`, undefined, {
      Authorization: `Bearer ${normalizeMakerWorldCookie(token)}`,
    })
    const data = readResponse(response)
    if (
      response.status === 401 &&
      (data.code === 4 ||
        [data.error, data.message].some(
          (value) => typeof value === 'string' && /please login/i.test(value),
        ))
    )
      return 'expired'
    if (
      response.status === 200 &&
      (data.code === undefined || data.code === null || data.code === 0)
    )
      return 'connected'
  } catch {
    /* An outage or access challenge does not prove that a stored token has expired. */
  }
  return 'unavailable'
}
