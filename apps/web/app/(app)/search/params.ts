/**
 * Search state lives entirely in the URL.
 *
 * That makes a search bookmarkable, shareable and reachable with the back
 * button, and it means the server can render results directly rather than
 * showing a spinner while the browser asks for them.
 */

import type { Route } from 'next'

export type RawParams = Record<string, string | string[] | undefined>

export interface ParsedSearchParams {
  q: string
  library: string[]
  creator: string[]
  tag: string[]
  license: string[]
  format: string[]
  presupported: boolean
  neverPrinted: boolean
  missingPreview: boolean
  minSize?: number
  sort: string
  page: number
}

const SORTS = new Set(['relevance', 'name', 'recent', 'oldest', 'largest'])

/** Repeatable params arrive as a string or an array depending on their count. */
function list(value: string | string[] | undefined): string[] {
  if (!value) return []
  const values = Array.isArray(value) ? value : [value]
  // Ids reach SQL as parameters, but keeping obvious rubbish out of the URL
  // state means the UI never renders a filter chip for something invalid.
  return values.filter((item) => item.length > 0 && item.length <= 64)
}

function flag(value: string | string[] | undefined): boolean {
  const single = Array.isArray(value) ? value[0] : value
  return single === '1' || single === 'true'
}

export function parseSearchParams(raw: RawParams): ParsedSearchParams {
  const sortValue = Array.isArray(raw.sort) ? raw.sort[0] : raw.sort
  const pageValue = Number(Array.isArray(raw.page) ? raw.page[0] : raw.page)
  const minSize = Number(Array.isArray(raw.minSize) ? raw.minSize[0] : raw.minSize)

  return {
    q: (Array.isArray(raw.q) ? (raw.q[0] ?? '') : (raw.q ?? '')).slice(0, 200),
    library: list(raw.library),
    creator: list(raw.creator),
    tag: list(raw.tag),
    license: list(raw.license),
    format: list(raw.format),
    presupported: flag(raw.presupported),
    neverPrinted: flag(raw.neverPrinted),
    missingPreview: flag(raw.missingPreview),
    minSize: Number.isFinite(minSize) && minSize > 0 ? minSize : undefined,
    sort: sortValue && SORTS.has(sortValue) ? sortValue : 'relevance',
    page: Number.isFinite(pageValue) && pageValue > 0 ? Math.floor(pageValue) : 1,
  }
}

/**
 * Builds a URL with some params changed.
 *
 * Any change other than the page itself resets to page one — landing on page 7
 * of a result set that now has two pages is the classic faceted-search
 * annoyance.
 */
export function buildHref(
  raw: RawParams,
  changes: Record<string, string | string[] | null>,
): Route {
  const params = new URLSearchParams()

  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || key in changes) continue
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, item)
  }

  for (const [key, value] of Object.entries(changes)) {
    if (value === null) continue
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item.length > 0) params.append(key, item)
    }
  }

  if (!('page' in changes)) params.delete('page')

  const query = params.toString()
  // Always a real /search URL, so asserting the Route type is accurate rather
  // than a way around the checker. typedRoutes cannot see through a URL built
  // at runtime.
  return (query ? `/search?${query}` : '/search') as Route
}

/** Adds or removes one value from a repeatable param. */
export function toggleHref(raw: RawParams, key: string, value: string): Route {
  const current = list(raw[key])
  const next = current.includes(value)
    ? current.filter((item) => item !== value)
    : [...current, value]
  return buildHref(raw, { [key]: next.length > 0 ? next : null })
}
