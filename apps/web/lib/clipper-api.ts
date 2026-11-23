import { can, MakerWorldImportError, PolicyError } from '@pb/core'
import { getDb, type Database } from '@pb/db'
import { readClipperTokenUser } from '@/lib/clipper-tokens'

export function clipperJson(body: object, status = 200): Response {
  const headers = new Headers({ 'Cache-Control': 'private, no-store' })
  if (status === 401) headers.set('WWW-Authenticate', 'Bearer realm="PrintBench clipper"')
  return Response.json(body, { status, headers })
}

type ClipperUser = NonNullable<Awaited<ReturnType<typeof readClipperTokenUser>>>

export async function withClipperUser(
  request: Request,
  execute: (db: Database, user: ClipperUser) => Promise<Response>,
): Promise<Response> {
  try {
    const db = getDb()
    const user = await readClipperTokenUser(db, request.headers.get('Authorization'))
    if (!user) return clipperJson({ error: 'Enter a valid PrintBench connection token.' }, 401)
    if (!can(user, 'file:upload')) return clipperJson({ error: 'Upload access is required.' }, 403)
    return await execute(db, user)
  } catch (error) {
    if (error instanceof PolicyError)
      return clipperJson({ error: 'Upload access is required.' }, 403)
    if (error instanceof MakerWorldImportError) return clipperJson({ error: error.message }, 400)
    return clipperJson({ error: 'PrintBench could not complete this request. Try again.' }, 503)
  }
}
