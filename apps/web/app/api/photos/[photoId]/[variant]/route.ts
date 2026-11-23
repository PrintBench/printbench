import { Readable } from 'node:stream'
import { getSessionUser } from '@pb/auth'
import { can, getPhotoKeys, getPhotoStore } from '@pb/core'
import { getDb } from '@pb/db'

export const dynamic = 'force-dynamic'

/**
 * Serves an uploaded photograph, either the display rendition or its tile.
 *
 * Authorisation happens here; delivery does not. In production the bytes go
 * to nginx via X-Accel-Redirect, the same arrangement generated thumbnails
 * use — a model with a dozen photos asks for a dozen images at once, and none
 * of them should occupy the process rendering pages.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ photoId: string; variant: string }> },
): Promise<Response> {
  const user = await getSessionUser()
  if (!can({ id: user?.id ?? '', role: user?.role ?? null }, 'model:view')) {
    return new Response('Not permitted', { status: 403 })
  }

  const { photoId, variant } = await params
  if (!/^[0-9a-f-]{36}$/i.test(photoId)) return new Response('Not found', { status: 404 })
  if (variant !== 'image' && variant !== 'thumb') {
    return new Response('Not found', { status: 404 })
  }

  const keys = await getPhotoKeys(getDb(), photoId)
  if (!keys) return new Response('Not found', { status: 404 })

  const key = variant === 'thumb' ? keys.thumbKey : keys.imageKey
  const store = getPhotoStore()

  /*
   * Keys are content-addressed, so a given URL's bytes never change and this
   * can be cached hard. Private, not public: a shared cache must not hand one
   * instance's photographs to another visitor.
   */
  const headers = {
    'content-type': 'image/webp',
    'cache-control': 'private, max-age=31536000, immutable',
  }

  if (process.env.FILE_DELIVERY === 'xaccel') {
    return new Response(null, {
      status: 200,
      headers: { ...headers, 'x-accel-redirect': store.internalPath(key) },
    })
  }

  const data = await store.read(key)
  if (!data) return new Response('Not found', { status: 404 })

  return new Response(Readable.toWeb(Readable.from(data)) as ReadableStream, { headers })
}
