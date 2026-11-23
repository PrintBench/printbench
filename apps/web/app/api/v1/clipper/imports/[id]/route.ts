import { getMakerWorldImportStatus } from '@pb/core'
import { clipperJson, withClipperUser } from '@/lib/clipper-api'

export function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withClipperUser(request, async (db, user) => {
    const { id } = await params
    const status = await getMakerWorldImportStatus(db, user.id, id)
    if (!status) return clipperJson({ error: 'That import was not found.' }, 404)
    return clipperJson(status)
  })
}
