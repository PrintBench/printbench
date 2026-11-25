/**
 * Catalogue browser state, kept in the URL like model search (see
 * app/(app)/search/params.ts): bookmarkable, back-button friendly, and
 * rendered on the server where the data is.
 */

import type { Route } from 'next'

export type RawParams = Record<string, string | string[] | undefined>

export interface CatalogParams {
  q: string
  brand?: string
  material?: string
  diameter?: number
  discontinued: boolean
  page: number
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseCatalogParams(raw: RawParams): CatalogParams {
  const brand = first(raw.brand)
  const material = first(raw.material)?.slice(0, 64)
  const diameter = Number(first(raw.diameter))
  const page = Number(first(raw.page))
  const discontinued = first(raw.discontinued)
  return {
    q: (first(raw.q) ?? '').slice(0, 200),
    brand: brand && UUID.test(brand) ? brand : undefined,
    material: material || undefined,
    diameter: Number.isFinite(diameter) && diameter > 0 && diameter < 10 ? diameter : undefined,
    discontinued: discontinued === '1' || discontinued === 'true',
    page: Number.isFinite(page) && page > 0 ? Math.floor(page) : 1,
  }
}

/** A catalogue URL with some params changed; anything but `page` resets to page one. */
export function catalogHref(raw: RawParams, changes: Record<string, string | null>): Route {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || key in changes) continue
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, item)
  }
  for (const [key, value] of Object.entries(changes)) {
    if (value) params.set(key, value)
  }
  if (!('page' in changes)) params.delete('page')
  const query = params.toString()
  // Always a real /filaments/catalog URL; typedRoutes cannot see one built at runtime.
  return (query ? `/filaments/catalog?${query}` : '/filaments/catalog') as Route
}
