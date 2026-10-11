import { getSessionUser } from '@pb/auth'
import { can } from '@pb/core'
import { getDb, getPool } from '@pb/db'
import { readActivity } from '@/lib/activity'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const user = await getSessionUser()
  const policyUser = { id: user?.id ?? '', role: user?.role ?? null, banned: user?.banned }
  if (!can(policyUser, 'model:view')) {
    return Response.json({ error: 'Not permitted' }, { status: 403 })
  }
  const trackedIds = [...new Set(new URL(request.url).searchParams.getAll('id'))]
  if (
    trackedIds.length > 1000 ||
    trackedIds.some(
      (id) => !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id),
    )
  ) {
    return Response.json({ error: 'Invalid activity IDs' }, { status: 400 })
  }
  try {
    const activities = await readActivity(
      getDb(),
      { executeSql: (query, values) => getPool().query(query, values) },
      can(policyUser, 'library:manage'),
      trackedIds,
    )
    return Response.json({ activities }, { headers: { 'cache-control': 'private, no-store' } })
  } catch {
    return Response.json(
      { error: 'Could not read activity' },
      {
        status: 503,
        headers: { 'cache-control': 'private, no-store' },
      },
    )
  }
}
