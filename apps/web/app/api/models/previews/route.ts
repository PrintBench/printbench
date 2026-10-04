import { getSessionUser } from '@pb/auth'
import { can, modelPreviewStatuses, PREVIEW_STATUS_BATCH_SIZE } from '@pb/core'
import { getDb } from '@pb/db'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const user = await getSessionUser()
  if (!can({ id: user?.id ?? '', role: user?.role ?? null }, 'model:view')) {
    return Response.json({ error: 'Not permitted' }, { status: 403 })
  }

  const ids = new URL(request.url).searchParams.getAll('id')
  if (
    ids.length === 0 ||
    ids.length > PREVIEW_STATUS_BATCH_SIZE ||
    ids.some((id) => !/^[a-zA-Z0-9_-]{1,64}$/.test(id))
  ) {
    return Response.json({ error: 'Supply between 1 and 200 valid model IDs' }, { status: 400 })
  }

  const previews = await modelPreviewStatuses(getDb(), ids)
  return Response.json({ previews }, { headers: { 'cache-control': 'private, no-store' } })
}
