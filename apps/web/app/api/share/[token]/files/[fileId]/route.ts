import { Readable } from 'node:stream'
import { eq } from 'drizzle-orm'
import {
  LocalAdapter,
  REVALIDATE_CACHE,
  accelMounts,
  accelRedirectPath,
  contentDisposition,
  getPreviewStore,
  getSettings,
  parseRange,
  shareTokenCoversFile,
  type LibraryLocation,
} from '@pm/core'
import { getDb, schema } from '@pm/db'

export const dynamic = 'force-dynamic'

/**
 * Serves one file of one shared model, to a visitor with no account.
 *
 * The token is checked against this exact file rather than against the model
 * the page happened to link. Without that, a share link would be a way to
 * fetch any file id in the instance — which is the whole library.
 *
 * Every refusal is a 404. A 403 would confirm that a file exists and that some
 * token once reached it, which is more than an anonymous caller should learn.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string; fileId: string }> },
): Promise<Response> {
  const { token, fileId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) return notFound()

  const db = getDb()

  // Turning sharing off closes every existing link at once, without having to
  // revoke them one by one.
  const { publicSharing } = await getSettings(db)
  if (!publicSharing) return notFound()

  if (!(await shareTokenCoversFile(db, token, fileId))) return notFound()

  const url = new URL(request.url)

  /*
   * Thumbnails come from the content-addressed preview store rather than the
   * library, so they are served here directly instead of falling through to
   * the storage adapter.
   */
  if (url.searchParams.get('thumb') === '1') {
    const thumbRows = await db
      .select({ thumbKey: schema.modelFiles.thumbKey, state: schema.modelFiles.thumbState })
      .from(schema.modelFiles)
      .where(eq(schema.modelFiles.id, fileId))
      .limit(1)

    const thumb = thumbRows[0]
    if (!thumb?.thumbKey || thumb.state !== 'ok') return notFound()

    const store = getPreviewStore()
    // Content-addressed, so these bytes never change and can be cached hard.
    const thumbHeaders = {
      'content-type': 'image/webp',
      'cache-control': 'public, max-age=31536000, immutable',
      'x-robots-tag': 'noindex',
    }

    if (process.env.FILE_DELIVERY === 'xaccel') {
      return new Response(null, {
        status: 200,
        headers: { ...thumbHeaders, 'x-accel-redirect': store.internalPath(thumb.thumbKey) },
      })
    }

    const data = await store.read(thumb.thumbKey)
    if (!data) return notFound()
    return new Response(Readable.toWeb(Readable.from(data)) as ReadableStream, {
      headers: thumbHeaders,
    })
  }

  const rows = await db
    .select({ file: schema.modelFiles, model: schema.models, library: schema.libraries })
    .from(schema.modelFiles)
    .innerJoin(schema.models, eq(schema.models.id, schema.modelFiles.modelId))
    .innerJoin(schema.libraries, eq(schema.libraries.id, schema.models.libraryId))
    .where(eq(schema.modelFiles.id, fileId))
    .limit(1)

  const row = rows[0]
  if (!row || row.library.backend !== 'local') return notFound()

  const location: LibraryLocation = {
    id: row.library.id,
    kind: row.library.kind,
    backend: row.library.backend,
    allowWrites: row.library.allowWrites,
    path: row.library.path,
  }
  const storage = new LocalAdapter(location)

  const relativePath = row.model.isFileModel
    ? row.model.path
    : `${row.model.path}/${row.file.filename}`

  const info = await storage.stat(relativePath).catch(() => null)
  if (!info) return notFound()

  const filename = row.file.filename.split('/').pop() ?? 'download'
  const inline = url.searchParams.get('inline') === '1'

  const headers: Record<string, string> = {
    'content-type': row.file.mediaType ?? 'application/octet-stream',
    'content-disposition': contentDisposition(filename, inline ? 'inline' : 'attachment'),
    'accept-ranges': 'bytes',
    'cache-control': REVALIDATE_CACHE,
    etag: `"${row.file.digest ?? `${info.size}-${info.mtimeMs}`}"`,
    // A shared file should not end up in a search index.
    'x-robots-tag': 'noindex, nofollow',
  }

  if (request.headers.get('if-none-match') === headers.etag) {
    return new Response(null, { status: 304, headers })
  }

  /*
   * Same nginx hand-off as the authenticated route. Authorisation has already
   * happened; only delivery is delegated.
   */
  if (process.env.FILE_DELIVERY === 'xaccel' && location.path) {
    // Relative to the nginx mount, not the library. See the note in the
    // authenticated raw route.
    const redirect = accelRedirectPath(location.path, relativePath, accelMounts())
    if (redirect) {
      return new Response(null, {
        status: 200,
        headers: { ...headers, 'x-accel-redirect': redirect },
      })
    }
  }

  const range = parseRange(request.headers.get('range'), info.size)

  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'content-range': `bytes */${info.size}` },
    })
  }

  if (range) {
    const stream = await storage.createReadStream(relativePath, {
      start: range.start,
      end: range.end,
    })
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: {
        ...headers,
        'content-range': `bytes ${range.start}-${range.end}/${info.size}`,
        'content-length': String(range.length),
      },
    })
  }

  const stream = await storage.createReadStream(relativePath)
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: { ...headers, 'content-length': String(info.size) },
  })
}

function notFound(): Response {
  return new Response('Not found', { status: 404 })
}
