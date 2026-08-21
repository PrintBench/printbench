import { getSessionUser } from '@pb/auth'
import { can, quickSearch } from '@pb/core'
import { getDb } from '@pb/db'

export const dynamic = 'force-dynamic'

/**
 * Lightweight search for the command palette.
 *
 * Separate from the search page because it fires on every keystroke: it wants
 * a handful of rows across several entity types, with no facets, no totals and
 * no pagination.
 */
export async function GET(request: Request): Promise<Response> {
  const user = await getSessionUser()
  if (!can({ id: user?.id ?? '', role: user?.role ?? null }, 'model:view')) {
    return Response.json({ hits: [] }, { status: 403 })
  }

  const query = new URL(request.url).searchParams.get('q') ?? ''
  if (query.trim().length === 0) return Response.json({ hits: [] })

  const hits = await quickSearch(getDb(), query, 12)

  return Response.json(
    { hits },
    // Private and short-lived: results depend on the session, and the palette
    // re-queries constantly while typing.
    { headers: { 'cache-control': 'private, max-age=5' } },
  )
}
