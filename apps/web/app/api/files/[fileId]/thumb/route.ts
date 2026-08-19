import { Readable } from 'node:stream'
import { eq } from 'drizzle-orm'
import { getSessionUser } from '@pm/auth'
import { can, getPreviewStore } from '@pm/core'
import { getDb, schema } from '@pm/db'

export const dynamic = 'force-dynamic'

/**
 * Serves a generated thumbnail.
 *
 * Authorisation happens here; delivery does not. In production the bytes are
 * handed to nginx via X-Accel-Redirect so they never pass through Node, which
 * matters when a grid of 48 tiles requests 48 images at once.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ fileId: string }> },
): Promise<Response> {
  const user = await getSessionUser()
  if (!can({ id: user?.id ?? '', role: user?.role ?? null }, 'model:view')) {
    return new Response('Not permitted', { status: 403 })
  }

  const { fileId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) {
    return new Response('Not found', { status: 404 })
  }

  const rows = await getDb()
    .select({ thumbKey: schema.modelFiles.thumbKey, state: schema.modelFiles.thumbState })
    .from(schema.modelFiles)
    .where(eq(schema.modelFiles.id, fileId))
    .limit(1)

  const file = rows[0]
  if (!file?.thumbKey || file.state !== 'ok') {
    // 404 rather than a placeholder image: the grid renders its own placeholder,
    // and a fake image would be cached as though it were real.
    return new Response('No thumbnail', { status: 404 })
  }

  const store = getPreviewStore()

  /*
   * Content-addressed keys mean a given URL's bytes never change, so this can
   * be cached hard. A regenerated thumbnail gets a different key and therefore
   * a different URL.
   */
  const headers = {
    'content-type': 'image/webp',
    'cache-control': 'public, max-age=31536000, immutable',
  }

  if (process.env.FILE_DELIVERY === 'xaccel') {
    return new Response(null, {
      status: 200,
      headers: { ...headers, 'x-accel-redirect': store.internalPath(file.thumbKey) },
    })
  }

  const data = await store.read(file.thumbKey)
  if (!data) return new Response('No thumbnail', { status: 404 })

  return new Response(Readable.toWeb(Readable.from(data)) as ReadableStream, { headers })
}
