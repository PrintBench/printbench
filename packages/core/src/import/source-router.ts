import { ImportProviderError, parseMakerWorldUrl } from './makerworld'
import { parsePrintablesUrl } from './printables'
import { parseThingiverseUrl } from './thingiverse'

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
