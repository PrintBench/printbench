import { listModelSourceImportTargets } from '@pb/core'
import { clipperJson, withClipperUser } from '@/lib/clipper-api'

export function GET(request: Request): Promise<Response> {
  return withClipperUser(request, async (db) =>
    clipperJson({ libraries: await listModelSourceImportTargets(db) }),
  )
}
