import { getSessionUser } from '@pb/auth'
import { can, getSettings, peekUpdateStatus } from '@pb/core'
import { getDb, getPool } from '@pb/db'
import { readActivity, updateActivity } from '@/lib/activity'

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
    // Only the people who can act on an upgrade are told about one, and only
    // when the instance is configured to look. `peek` never waits on the
    // network: this response is on a three-second poll.
    if (can(policyUser, 'settings:manage') && (await getSettings(getDb())).updateChecks) {
      const update = updateActivity(peekUpdateStatus({ currentVersion: process.env.PB_VERSION }))
      if (update) activities.push(update)
    }
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
