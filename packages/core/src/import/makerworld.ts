import { z } from 'zod'
import {
  requestMakerWorldJson,
  validateMakerWorldRemoteUrl,
  type MakerWorldRequest,
  type MakerWorldResponse,
} from './makerworld-network'

export class ImportProviderError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_URL'
      | 'INVALID_CREDENTIAL'
      | 'AUTH_REQUIRED'
      | 'FORBIDDEN'
      | 'NOT_FOUND'
      | 'RATE_LIMITED'
      | 'UNAVAILABLE'
      | 'INVALID_RESPONSE',
    message: string,
  ) {
    super(message)
    this.name = 'ImportProviderError'
  }
}

export interface MakerWorldModel {
  sourceUrl: string
  externalId: string
  title: string
  /** Plain text only. Render as text, never as HTML. */
  description: string | null
  /** Provider's license identifier; unknown identifiers are preserved. */
  license: string | null
  creator: { name: string; url: string | null } | null
  tags: string[]
  thumbnailUrl: string | null
  profiles: { id: string; title: string }[]
  /** Signed URLs expire quickly; resolve in the worker immediately before downloading. */
  files: { profileId: string; filename: string; url: string }[]
}

export interface MakerWorldDependencies {
  request?: (url: string, options: MakerWorldRequest) => Promise<MakerWorldResponse>
  /** Omitted: URL-selected profile, otherwise the first published profile. */
  profileIds?: string[]
  /** Internal identity expected when resolving a downloaded project. */
  expectedModelId?: string
}

export function parseMakerWorldUrl(value: string): {
  sourceUrl: string
  externalId: string
  profileId: string | null
} {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ImportProviderError('INVALID_URL', 'Enter a MakerWorld model URL')
  }
  const match = url.pathname.match(
    /^\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?models\/([1-9]\d*)(?:-[^/]*)?\/?$/,
  )
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'makerworld.com' ||
    url.port ||
    url.username ||
    url.password ||
    !match
  ) {
    throw new ImportProviderError(
      'INVALID_URL',
      'Only https://makerworld.com model URLs are supported',
    )
  }
  const externalId = match[1]!
  if (externalId.length > 16)
    throw new ImportProviderError('INVALID_URL', 'Invalid MakerWorld model ID')
  const profileId = url.hash.match(/^#profileId-([1-9]\d{0,15})$/)?.[1] ?? null
  return { sourceUrl: `https://makerworld.com/en/models/${externalId}`, externalId, profileId }
}

/** Accept a user-entered token or Cookie header, discarding unrelated cookies. */
export function normalizeMakerWorldCookie(value: string): string {
  if (value.length > 16_384 || /[\r\n]/.test(value)) {
    throw new ImportProviderError('INVALID_CREDENTIAL', 'Invalid MakerWorld session value')
  }
  const raw = value.trim().replace(/^cookie:\s*/i, '')
  const token =
    raw.includes('=') || raw.includes(';')
      ? raw
          .split(';')
          .map((part) => part.trim())
          .find((part) => part.startsWith('token='))
          ?.slice(6)
      : raw
  if (!token || !/^[A-Za-z0-9._~-]+$/.test(token)) {
    throw new ImportProviderError(
      'INVALID_CREDENTIAL',
      'Paste the MakerWorld token cookie or its value',
    )
  }
  return token
}

const numericId = z.union([z.number().int().positive().safe(), z.string().regex(/^[1-9]\d{0,15}$/)])
const designSchema = z.object({
  id: numericId,
  modelId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  title: z.string().trim().min(1).max(1000),
  summary: z.string().max(1_000_000).nullish(),
  license: z.string().max(256).nullish(),
  tags: z.array(z.string().max(256)).max(200).default([]),
  coverUrl: z.string().max(4096).nullish(),
  designCreator: z
    .object({ name: z.string().max(512), handle: z.string().max(256).optional() })
    .nullish(),
  instances: z
    .array(
      z.object({
        id: numericId,
        profileId: numericId.optional(),
        title: z.string().max(1000).default(''),
      }),
    )
    .max(1000)
    .default([]),
})

/** Small text conversion, deliberately not an HTML sanitizer. */
function plainText(value: string): string {
  const entities: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  }
  return value
    .replace(/<(script|style|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\s*(?:br\b[^>]*|\/(?:p|div|h[1-6]|li|ul|ol))\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (full, entity: string) => {
      if (!entity.startsWith('#')) return entities[entity.toLowerCase()] ?? full
      const number =
        entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))
      return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)
        ? String.fromCodePoint(number)
        : ''
    })
    .replace(/[\t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function filename(value: string | undefined, profileId: string): string {
  let decoded = value ?? ''
  try {
    decoded = decodeURIComponent(decoded)
  } catch {
    /* Preserve malformed percent text as a name. */
  }
  const clean =
    decoded
      .split(/[\\/]/)
      .pop()
      ?.split('')
      .map((character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? '_' : character,
      )
      .join('')
      .replace(/[<>:"|?*]/g, '_')
      .trim()
      .slice(0, 180) ?? ''
  return clean.toLowerCase().endsWith('.3mf') && clean.length > 4
    ? clean
    : `makerworld-profile-${profileId}.3mf`
}

/**
 * Resolve official Bambu Cloud responses without browser scraping or challenge
 * workarounds. Public metadata shape was checked against design/15106. Downloads
 * require an explicitly supplied own-account session; access refusals are final.
 */
export async function fetchMakerWorldModel(
  value: string,
  cookie?: string,
  deps: MakerWorldDependencies = {},
): Promise<MakerWorldModel> {
  const parsedUrl = parseMakerWorldUrl(value)
  const token = cookie ? normalizeMakerWorldCookie(cookie) : null
  const request = deps.request ?? requestMakerWorldJson
  const validated = designSchema.safeParse(
    await getMakerWorldJson(`/v1/design-service/design/${parsedUrl.externalId}`, request),
  )
  if (
    !validated.success ||
    String(validated.data.id) !== parsedUrl.externalId ||
    (deps.expectedModelId && validated.data.modelId !== deps.expectedModelId)
  ) {
    throw new ImportProviderError(
      'INVALID_RESPONSE',
      'MakerWorld returned an unsupported model response',
    )
  }
  const design = validated.data
  let thumbnailUrl: string | null = null
  if (design.coverUrl) {
    try {
      thumbnailUrl = validateMakerWorldRemoteUrl(design.coverUrl).href
    } catch {
      /* Ignore unsafe optional artwork. */
    }
  }
  const profiles = design.instances.map((profile) => ({
    id: String(profile.id),
    title: plainText(profile.title),
  }))
  const model: MakerWorldModel = {
    sourceUrl: parsedUrl.sourceUrl,
    externalId: parsedUrl.externalId,
    title: plainText(design.title),
    description: design.summary ? plainText(design.summary) : null,
    license: design.license ?? null,
    creator: design.designCreator
      ? {
          name: plainText(design.designCreator.name),
          url: design.designCreator.handle
            ? `https://makerworld.com/en/@${encodeURIComponent(design.designCreator.handle)}`
            : null,
        }
      : null,
    tags: [...new Set(design.tags.map((tag) => plainText(tag).trim()).filter(Boolean))],
    thumbnailUrl,
    profiles,
    files: [],
  }
  if (!token) return model
  const selected =
    deps.profileIds ??
    (parsedUrl.profileId
      ? [parsedUrl.profileId]
      : profiles.slice(0, 1).map((profile) => profile.id))
  if (
    selected.length > 20 ||
    selected.some((id) => !profiles.some((profile) => profile.id === id))
  ) {
    throw new ImportProviderError(
      'INVALID_URL',
      'Choose at most 20 published profiles from this model',
    )
  }
  for (const profileId of new Set(selected)) {
    // The URL fragment uses the instance id; the download API uses profileId.
    // Never guess between them: they identify different provider records.
    const internalId = design.instances.find(
      (profile) => String(profile.id) === profileId,
    )?.profileId
    if (!internalId)
      throw new ImportProviderError(
        'INVALID_RESPONSE',
        'MakerWorld did not provide a download profile ID',
      )
    const response = await getMakerWorldJson(
      `/v1/iot-service/api/user/profile/${internalId}?model_id=${encodeURIComponent(design.modelId)}`,
      request,
      token,
    )
    const download = z
      .object({ url: z.string().max(16_384), name: z.string().max(4096).optional() })
      .safeParse(response)
    if (!download.success)
      throw new ImportProviderError(
        'INVALID_RESPONSE',
        'MakerWorld returned an unsupported download response',
      )
    try {
      validateMakerWorldRemoteUrl(download.data.url)
    } catch {
      throw new ImportProviderError(
        'INVALID_RESPONSE',
        'MakerWorld returned an unsupported download host',
      )
    }
    // Keep the exact signed URL bytes rather than serializing URL search params.
    model.files.push({
      profileId,
      filename: filename(download.data.name, profileId),
      url: download.data.url,
    })
  }
  return model
}

async function getMakerWorldJson(
  path: string,
  request: NonNullable<MakerWorldDependencies['request']>,
  token: string | null = null,
): Promise<unknown> {
  let response: MakerWorldResponse
  try {
    response = await request(`https://api.bambulab.com${path}`, {
      maxBytes: 4 * 1024 * 1024,
      timeoutMs: 20_000,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
  } catch {
    throw new ImportProviderError('UNAVAILABLE', 'MakerWorld could not be reached')
  }
  if (response.status === 400)
    throw new ImportProviderError(
      'INVALID_RESPONSE',
      'MakerWorld rejected the model or print profile',
    )
  if (response.status === 401)
    throw new ImportProviderError('AUTH_REQUIRED', 'MakerWorld sign-in is required or has expired')
  if (response.status === 403)
    throw new ImportProviderError(
      'FORBIDDEN',
      'MakerWorld refused this request; check access in MakerWorld',
    )
  if (response.status === 404)
    throw new ImportProviderError('NOT_FOUND', 'MakerWorld model or profile was not found')
  if (response.status === 429)
    throw new ImportProviderError(
      'RATE_LIMITED',
      'MakerWorld is rate limiting requests; try again later',
    )
  if (response.status !== 200)
    throw new ImportProviderError('UNAVAILABLE', 'MakerWorld returned an unexpected response')
  if (response.body.length > 4 * 1024 * 1024)
    throw new ImportProviderError('INVALID_RESPONSE', 'MakerWorld metadata exceeds the limit')
  try {
    return JSON.parse(response.body.toString('utf8'))
  } catch {
    throw new ImportProviderError('INVALID_RESPONSE', 'MakerWorld returned invalid metadata')
  }
}

/**
 * Bambu Studio resolves its embedded DesignModelId with this mapping endpoint.
 * Check the returned design's modelId too: neither numeric profile ids nor titles
 * are safe substitutes for an exact source identity. This never resolves files.
 */
export async function fetchMakerWorldProjectMetadata(
  internalModelId: string,
  deps: Pick<MakerWorldDependencies, 'request'> = {},
): Promise<MakerWorldModel> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(internalModelId))
    throw new ImportProviderError('INVALID_RESPONSE', 'Invalid MakerWorld project identifier')
  const request = deps.request ?? requestMakerWorldJson
  const mapping = z
    .object({ id: numericId })
    .safeParse(
      await getMakerWorldJson(
        `/v1/design-service/model/${encodeURIComponent(internalModelId)}`,
        request,
      ),
    )
  if (!mapping.success)
    throw new ImportProviderError('INVALID_RESPONSE', 'MakerWorld could not identify this project')
  return fetchMakerWorldModel(`https://makerworld.com/en/models/${mapping.data.id}`, undefined, {
    request,
    expectedModelId: internalModelId,
  })
}
