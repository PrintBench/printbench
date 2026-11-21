import { ImportProviderError } from './provider-error'

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

export type ModelSourceProvider = 'makerworld' | 'printables' | 'thingiverse'

export function parseModelSourceUrl(value: string): {
  provider: ModelSourceProvider
  externalId: string
  sourceUrl: string
} {
  let host: string
  try {
    host = new URL(value).hostname
  } catch {
    throw new ImportProviderError('INVALID_URL', 'Enter a supported model-page URL')
  }
  if (['makerworld.com', 'www.makerworld.com'].includes(host)) {
    const parsed = parseMakerWorldUrl(value)
    return {
      provider: 'makerworld',
      externalId: parsed.externalId,
      sourceUrl: parsed.sourceUrl + (parsed.profileId ? `#profileId-${parsed.profileId}` : ''),
    }
  }
  if (['printables.com', 'www.printables.com'].includes(host)) {
    const parsed = parsePrintablesUrl(value)
    return { provider: 'printables', externalId: parsed.externalId, sourceUrl: parsed.sourceUrl }
  }
  if (['thingiverse.com', 'www.thingiverse.com'].includes(host)) {
    const parsed = parseThingiverseUrl(value)
    return { provider: 'thingiverse', externalId: parsed.externalId, sourceUrl: parsed.sourceUrl }
  }
  throw new ImportProviderError(
    'INVALID_URL',
    'Use a MakerWorld, Printables, or Thingiverse model URL',
  )
}
