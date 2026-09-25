import { getSessionUser } from '@pb/auth'
import { can, searchModels } from '@pb/core'
import { getDb } from '@pb/db'

export const dynamic = 'force-dynamic'

const MAX_LIMIT = 100
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Paginated creator items for the creator detail page.
 *
 * Packages and regular models are requested separately so large creator
 * libraries can be browsed without rendering every item at once.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ creatorId: string }> },
): Promise<Response> {
  const user = await getSessionUser()
  if (!can({ id: user?.id ?? '', role: user?.role ?? null }, 'model:view')) {
    return Response.json({ hits: [], total: 0 }, { status: 403 })
  }

  const { creatorId } = await params
  if (!UUID_PATTERN.test(creatorId)) {
    return Response.json({ error: 'Invalid creator ID' }, { status: 400 })
  }

  const searchParams = new URL(request.url).searchParams

  const type = searchParams.get('type')
  if (type !== 'model' && type !== 'package') {
    return Response.json({ error: 'type must be "model" or "package"' }, { status: 400 })
  }

  const rawOffset = Number.parseInt(searchParams.get('offset') ?? '0', 10)
  const rawLimit = Number.parseInt(searchParams.get('limit') ?? '48', 10)

  const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), MAX_LIMIT) : 48

  const result = await searchModels(getDb(), {
    creatorIds: [creatorId],
    isPackage: type === 'package',
    offset,
    limit,
    includeFacets: false,
  })

  return Response.json(
    {
      hits: result.hits,
      total: result.total,
    },
    { headers: { 'cache-control': 'private, no-store' } },
  )
}
