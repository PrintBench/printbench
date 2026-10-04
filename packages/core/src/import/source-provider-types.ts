import type { SourceRequest, SourceResponse } from './source-network'

export type ExternalSourceProvider = 'printables' | 'thingiverse'
export type SourceFileFormat = 'stl' | '3mf' | 'obj' | 'ply'

export interface ExternalSourceModel {
  sourceUrl: string
  externalId: string
  title: string
  /** Plain text. Provider HTML must never be rendered directly. */
  description: string | null
  license: string | null
  creator: { name: string; url: string | null } | null
  tags: string[]
  thumbnailUrl: string | null
  /** Resolve in the worker immediately before downloading; URLs can expire. */
  files: { id: string; filename: string; url: string; format: SourceFileFormat }[]
}

export interface ExternalSourceDependencies {
  request?: (
    provider: ExternalSourceProvider,
    url: string,
    options: SourceRequest,
  ) => Promise<SourceResponse>
  /** Metadata enrichment avoids resolving file download links. */
  metadataOnly?: boolean
}

export function sourcePlainText(value: string): string {
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

export function sourceFilename(
  value: string,
  id: string,
): { filename: string; format: SourceFileFormat } | null {
  const extension = value.toLowerCase().match(/\.(stl|3mf|obj|ply)$/)?.[1] as
    SourceFileFormat | undefined
  if (!extension) return null
  const clean =
    value
      .split(/[\\/]/)
      .pop()
      ?.split('')
      .map((character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? '_' : character,
      )
      .join('')
      .replace(/[<>:"|?*]/g, '_')
      .trim() ?? ''
  const stem = clean
    .slice(0, -(extension.length + 1))
    .slice(0, 160)
    .trim()
  return { filename: `${stem || `file-${id}`}.${extension}`, format: extension }
}
