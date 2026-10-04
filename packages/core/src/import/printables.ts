import { z } from 'zod'
import { ImportProviderError } from './makerworld'
import { requestSourceJson, validateSourceRemoteUrl, type SourceResponse } from './source-network'
import {
  sourcePlainText,
  sourceFilename,
  type ExternalSourceModel,
  type ExternalSourceDependencies,
} from './source-provider-types'

export function parsePrintablesUrl(value: string): { sourceUrl: string; externalId: string } {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ImportProviderError('INVALID_URL', 'Enter a Printables model URL')
  }
  const match = url.pathname.match(/^\/(?:[a-z]{2}\/)?model\/([1-9]\d{0,15})(?:-[^/]*)?\/?$/)
  if (
    url.protocol !== 'https:' ||
    !['printables.com', 'www.printables.com'].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    !match
  )
    throw new ImportProviderError(
      'INVALID_URL',
      'Only https://www.printables.com/model/ID model URLs are supported',
    )
  return { sourceUrl: `https://www.printables.com/model/${match[1]}`, externalId: match[1]! }
}
const id = z.union([z.number().int().positive().safe(), z.string().regex(/^[1-9]\d{0,15}$/)])
const image = z.object({ filePath: z.string().max(16384) })
const file = z.object({ id, name: z.string().max(4096) })
const printSchema = z.object({
  id,
  name: z.string().trim().min(1).max(1000),
  summary: z.string().max(1_000_000).nullish(),
  description: z.string().max(1_000_000).nullish(),
  user: z
    .object({ publicUsername: z.string().max(512), handle: z.string().max(256).nullish() })
    .nullish(),
  license: z.object({ name: z.string().max(256) }).nullish(),
  tags: z
    .array(z.object({ name: z.string().max(256) }))
    .max(200)
    .default([]),
  image: image.nullish(),
  images: z.array(image).max(1000).default([]),
  stls: z.array(file).max(1000).default([]),
  otherFiles: z.array(file).max(1000).default([]),
})

/** Public website API. Returned access errors are final, including paid/club files. */
export async function fetchPrintablesModel(
  value: string,
  deps: ExternalSourceDependencies = {},
): Promise<ExternalSourceModel> {
  const parsed = parsePrintablesUrl(value)
  const request = deps.request ?? requestSourceJson
  const graphql = async (query: string): Promise<Record<string, unknown>> => {
    let response: SourceResponse
    try {
      response = await request('printables', 'https://api.printables.com/graphql/', {
        method: 'POST',
        body: JSON.stringify({ query }),
        headers: { 'Content-Type': 'application/json' },
        maxBytes: 4 * 1024 * 1024,
        timeoutMs: 20_000,
      })
    } catch {
      throw new ImportProviderError('UNAVAILABLE', 'Printables could not be reached')
    }
    if (response.status === 401)
      throw new ImportProviderError(
        'AUTH_REQUIRED',
        'This Printables model requires access that is not supported by public import',
      )
    if (response.status === 403)
      throw new ImportProviderError(
        'FORBIDDEN',
        'Printables refused this request; check access in Printables',
      )
    if (response.status === 404)
      throw new ImportProviderError('NOT_FOUND', 'Printables model was not found')
    if (response.status === 429)
      throw new ImportProviderError(
        'RATE_LIMITED',
        'Printables is rate limiting requests; try again later',
      )
    if (response.status !== 200)
      throw new ImportProviderError('UNAVAILABLE', 'Printables returned an unexpected response')
    if (response.body.length > 4 * 1024 * 1024)
      throw new ImportProviderError('INVALID_RESPONSE', 'Printables metadata exceeds the limit')
    let result: unknown
    try {
      result = JSON.parse(response.body.toString('utf8'))
    } catch {
      throw new ImportProviderError('INVALID_RESPONSE', 'Printables returned invalid metadata')
    }
    const envelope = z
      .object({
        data: z.record(z.string(), z.unknown()).nullish(),
        errors: z.array(z.unknown()).optional(),
      })
      .safeParse(result)
    if (!envelope.success || !envelope.data.data || envelope.data.errors?.length)
      throw new ImportProviderError(
        'INVALID_RESPONSE',
        'Printables returned an unsupported API response',
      )
    return envelope.data.data
  }
  const response = await graphql(
    `query { print(id: "${parsed.externalId}") { id name summary description user { publicUsername handle } license { name } tags { name } image { filePath } images { filePath } stls { id name } otherFiles { id name } } }`,
  )
  if (response.print === null)
    throw new ImportProviderError('NOT_FOUND', 'Printables model was not found')
  const validated = printSchema.safeParse(response.print)
  if (!validated.success || String(validated.data.id) !== parsed.externalId)
    throw new ImportProviderError(
      'INVALID_RESPONSE',
      'Printables returned an unsupported model response',
    )
  const print = validated.data
  const candidates = [print.image, ...print.images].filter((entry) => entry != null)
  const thumbnailUrl =
    candidates
      .map((entry) => {
        try {
          return validateSourceRemoteUrl(
            'printables',
            new URL(entry.filePath, 'https://media.printables.com/').href,
          ).href
        } catch {
          return null
        }
      })
      .find(Boolean) ?? null
  const model: ExternalSourceModel = {
    ...parsed,
    title: sourcePlainText(print.name),
    description:
      print.description || print.summary
        ? sourcePlainText(print.description || print.summary!)
        : null,
    license: print.license?.name ?? null,
    creator: print.user
      ? {
          name: sourcePlainText(print.user.publicUsername),
          url: print.user.handle
            ? `https://www.printables.com/@${encodeURIComponent(print.user.handle)}`
            : null,
        }
      : null,
    tags: [...new Set(print.tags.map((tag) => sourcePlainText(tag.name).trim()).filter(Boolean))],
    thumbnailUrl,
    files: [],
  }
  if (deps.metadataOnly) return model
  const downloads = [
    ...print.stls.map((item) => ({ ...item, type: 'stl' })),
    ...print.otherFiles.map((item) => ({ ...item, type: 'other' })),
  ].filter((item) => sourceFilename(item.name, String(item.id)))
  if (!downloads.length)
    throw new ImportProviderError(
      'NOT_FOUND',
      'Printables did not provide supported 3D model files',
    )
  if (downloads.length > 100)
    throw new ImportProviderError(
      'INVALID_RESPONSE',
      'Printables model has too many files to import',
    )
  for (const item of downloads) {
    const download = await graphql(
      `mutation { getDownloadLink(id: "${item.id}", printId: "${parsed.externalId}", fileType: ${item.type}, source: model_detail) { ok output { link } } }`,
    )
    const result = z
      .object({ ok: z.boolean(), output: z.object({ link: z.string().max(16384) }).nullish() })
      .safeParse(download.getDownloadLink)
    if (!result.success)
      throw new ImportProviderError(
        'INVALID_RESPONSE',
        'Printables returned an unsupported download response',
      )
    if (!result.data.ok || !result.data.output)
      throw new ImportProviderError(
        'FORBIDDEN',
        'Printables did not grant access to a model file; check access in Printables',
      )
    try {
      validateSourceRemoteUrl('printables', result.data.output.link)
    } catch {
      throw new ImportProviderError(
        'INVALID_RESPONSE',
        'Printables returned an unsupported download host',
      )
    }
    model.files.push({
      id: String(item.id),
      ...sourceFilename(item.name, String(item.id))!,
      url: result.data.output.link,
    })
  }
  return model
}
