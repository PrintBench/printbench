import { z } from 'zod'
import { ImportProviderError } from './makerworld'
import { requestSourceJson, validateSourceRemoteUrl, type SourceResponse } from './source-network'
import {
  sourcePlainText,
  sourceFilename,
  type ExternalSourceModel,
  type ExternalSourceDependencies,
} from './source-provider-types'

export function parseThingiverseUrl(value: string): { sourceUrl: string; externalId: string } {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ImportProviderError('INVALID_URL', 'Enter a Thingiverse model URL')
  }
  const match = url.pathname.match(/^\/thing:([1-9]\d{0,15})\/?$/)
  if (
    url.protocol !== 'https:' ||
    !['thingiverse.com', 'www.thingiverse.com'].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    !match
  )
    throw new ImportProviderError(
      'INVALID_URL',
      'Only https://www.thingiverse.com/thing:ID model URLs are supported',
    )
  return { sourceUrl: `https://www.thingiverse.com/thing:${match[1]}`, externalId: match[1]! }
}

/** A user-supplied OAuth access token; never reuse a third party application's key. */
export function normalizeThingiverseToken(value: string): string {
  const token = value.trim().replace(/^Bearer\s+/i, '')
  if (!/^[A-Za-z0-9._~-]{1,16384}$/.test(token))
    throw new ImportProviderError('INVALID_CREDENTIAL', 'Enter a valid Thingiverse access token')
  return token
}
const id = z.union([z.number().int().positive().safe(), z.string().regex(/^[1-9]\d{0,15}$/)])
const imageSchema = z.object({
  url: z.string().max(16384).nullish(),
  sizes: z
    .array(
      z.object({
        size: z.string().max(64).optional(),
        type: z.string().max(64).optional(),
        url: z.string().max(16384),
      }),
    )
    .max(100)
    .default([]),
})
const thingSchema = z.object({
  id,
  name: z.string().trim().min(1).max(1000),
  description: z.string().max(1_000_000).nullish(),
  description_html: z.string().max(1_000_000).nullish(),
  license: z.string().max(256).nullish(),
  creator: z
    .object({
      name: z.string().max(512).optional(),
      first_name: z.string().max(512).optional(),
      last_name: z.string().max(512).optional(),
    })
    .nullish(),
  default_image: imageSchema.nullish(),
})
const filesSchema = z
  .array(
    z.object({
      id,
      name: z.string().max(4096),
      direct_url: z.string().max(16384).nullish(),
      download_url: z.string().max(16384).nullish(),
    }),
  )
  .max(1000)
const tagsSchema = z.array(z.object({ name: z.string().max(256) })).max(200)

export async function fetchThingiverseModel(
  value: string,
  credential?: string,
  deps: ExternalSourceDependencies = {},
): Promise<ExternalSourceModel> {
  const parsed = parseThingiverseUrl(value)
  if (!credential)
    throw new ImportProviderError(
      'AUTH_REQUIRED',
      'Save a Thingiverse access token in account settings first',
    )
  const token = normalizeThingiverseToken(credential)
  const request = deps.request ?? requestSourceJson
  const get = async (path: string): Promise<unknown> => {
    let response: SourceResponse
    try {
      response = await request('thingiverse', `https://api.thingiverse.com${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        maxBytes: 4 * 1024 * 1024,
        timeoutMs: 20_000,
      })
    } catch {
      throw new ImportProviderError('UNAVAILABLE', 'Thingiverse could not be reached')
    }
    if (response.status === 401)
      throw new ImportProviderError(
        'AUTH_REQUIRED',
        'Thingiverse access token is invalid or has expired',
      )
    if (response.status === 403)
      throw new ImportProviderError(
        'FORBIDDEN',
        'Thingiverse refused this request; check access in Thingiverse',
      )
    if (response.status === 404)
      throw new ImportProviderError('NOT_FOUND', 'Thingiverse model was not found')
    if (response.status === 429)
      throw new ImportProviderError(
        'RATE_LIMITED',
        'Thingiverse is rate limiting requests; try again later',
      )
    if (response.status !== 200)
      throw new ImportProviderError('UNAVAILABLE', 'Thingiverse returned an unexpected response')
    if (response.body.length > 4 * 1024 * 1024)
      throw new ImportProviderError('INVALID_RESPONSE', 'Thingiverse metadata exceeds the limit')
    try {
      return JSON.parse(response.body.toString('utf8'))
    } catch {
      throw new ImportProviderError('INVALID_RESPONSE', 'Thingiverse returned invalid metadata')
    }
  }
  const thing = thingSchema.safeParse(await get(`/things/${parsed.externalId}`))
  if (!thing.success || String(thing.data.id) !== parsed.externalId)
    throw new ImportProviderError(
      'INVALID_RESPONSE',
      'Thingiverse returned an unsupported model response',
    )
  const tags = tagsSchema.safeParse(await get(`/things/${parsed.externalId}/tags`))
  if (!tags.success)
    throw new ImportProviderError('INVALID_RESPONSE', 'Thingiverse returned unsupported tags')
  const data = thing.data
  const candidates = [...(data.default_image?.sizes ?? [])]
    .sort(
      (a, b) =>
        Number(b.size === 'large') - Number(a.size === 'large') ||
        Number(b.type === 'display') - Number(a.type === 'display'),
    )
    .map((image) => image.url)
  if (data.default_image?.url) candidates.unshift(data.default_image.url)
  const thumbnailUrl =
    candidates
      .map((url) => {
        try {
          return validateSourceRemoteUrl('thingiverse', url).href
        } catch {
          return null
        }
      })
      .find(Boolean) ?? null
  const creatorName =
    data.creator?.name ??
    [data.creator?.first_name, data.creator?.last_name].filter(Boolean).join(' ')
  const model: ExternalSourceModel = {
    ...parsed,
    title: sourcePlainText(data.name),
    description:
      data.description_html || data.description
        ? sourcePlainText(data.description_html || data.description!)
        : null,
    license: data.license ?? null,
    creator: creatorName
      ? {
          name: sourcePlainText(creatorName),
          url: data.creator?.name
            ? `https://www.thingiverse.com/${encodeURIComponent(data.creator.name)}`
            : null,
        }
      : null,
    tags: [...new Set(tags.data.map((tag) => sourcePlainText(tag.name).trim()).filter(Boolean))],
    thumbnailUrl,
    files: [],
  }
  if (deps.metadataOnly) return model
  const files = filesSchema.safeParse(await get(`/things/${parsed.externalId}/files`))
  if (!files.success)
    throw new ImportProviderError('INVALID_RESPONSE', 'Thingiverse returned unsupported files')
  for (const file of files.data) {
    const name = sourceFilename(file.name, String(file.id))
    if (!name) continue
    let url =
      file.direct_url ||
      file.download_url ||
      `https://api.thingiverse.com/files/${file.id}/download`
    try {
      const api = new URL(url).hostname === 'api.thingiverse.com'
      const validated = validateSourceRemoteUrl('thingiverse', url, api)
      if (
        api &&
        ![`/files/${file.id}/download`, `/v2/files/${file.id}/download`].includes(
          validated.pathname,
        )
      )
        throw new Error('Unexpected file download identity')
      // Preserve signed query bytes; authorization goes only to a fixed API host.
      url = file.direct_url || file.download_url || validated.href
    } catch {
      throw new ImportProviderError(
        'INVALID_RESPONSE',
        'Thingiverse returned an unsupported download URL',
      )
    }
    model.files.push({ id: String(file.id), ...name, url })
  }
  if (!model.files.length)
    throw new ImportProviderError(
      'NOT_FOUND',
      'Thingiverse did not provide supported 3D model files',
    )
  if (model.files.length > 100)
    throw new ImportProviderError(
      'INVALID_RESPONSE',
      'Thingiverse model has too many files to import',
    )
  return model
}
