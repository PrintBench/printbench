import { Readable } from 'node:stream'
import { eq } from 'drizzle-orm'
import { getSessionUser } from '@pm/auth'
import {
  REVALIDATE_CACHE,
  can,
  accelMounts,
  accelRedirectPath,
  contentDisposition,
  createStorageAdapter,
  libraryLocationFromRow,
  parseRange,
  verifyToken,
} from '@pm/core'
import { getDb, schema } from '@pm/db'

/**
 * Serves the bytes of one file, for download or for the 3D viewer.
 *
 * Authorisation happens here. Delivery, in production, does not: the response
 * carries an X-Accel-Redirect and nginx sends the file with sendfile and its
 * own Range handling, so a multi-gigabyte download never passes through the
 * Node event loop. Development has no proxy, so it streams — with Range
 * implemented by hand, because the viewer and resumable downloads depend on it.
 */
/**
 * Serves one file's bytes, for download, the viewer, or a desktop slicer.
 *
 * Lives here rather than in a route module because two routes need it: the
 * plain `/raw` one, and `/raw/<filename>`, which exists so the URL ends in a
 * real extension. See the note on the slicer links.
 */
export async function serveFile(request: Request, fileId: string): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) return new Response('Not found', { status: 404 })

  if (!(await isAuthorised(request, fileId))) {
    return new Response('Not permitted', { status: 403 })
  }

  const rows = await getDb()
    .select({ file: schema.modelFiles, model: schema.models, library: schema.libraries })
    .from(schema.modelFiles)
    .innerJoin(schema.models, eq(schema.models.id, schema.modelFiles.modelId))
    .innerJoin(schema.libraries, eq(schema.libraries.id, schema.models.libraryId))
    .where(eq(schema.modelFiles.id, fileId))
    .limit(1)

  const row = rows[0]
  if (!row || row.file.missingAt) return new Response('Not found', { status: 404 })

  const location = libraryLocationFromRow(row.library)
  const storage = createStorageAdapter(location)

  // A model that is a single loose file has no folder of its own.
  const relativePath = row.model.isFileModel
    ? row.model.path
    : `${row.model.path}/${row.file.filename}`

  // Size comes from disk rather than the database: the row may be stale between
  // scans, and a wrong Content-Length truncates the download.
  const info = await storage.stat(relativePath).catch(() => null)
  if (!info) return new Response('File is no longer on disk', { status: 404 })

  const filename = row.file.filename.split('/').pop() ?? 'download'
  // The viewer fetches with ?inline=1; a browser must not offer to save that.
  const inline = new URL(request.url).searchParams.get('inline') === '1'

  const baseHeaders: Record<string, string> = {
    'content-type': row.file.mediaType ?? 'application/octet-stream',
    'content-disposition': contentDisposition(filename, inline ? 'inline' : 'attachment'),
    'accept-ranges': 'bytes',
    'cache-control': REVALIDATE_CACHE,
    // Lets a conditional request skip the transfer entirely.
    etag: `"${row.file.digest ?? `${info.size}-${info.mtimeMs}`}"`,
  }

  if (request.headers.get('if-none-match') === baseHeaders.etag) {
    return new Response(null, { status: 304, headers: baseHeaders })
  }

  /*
   * S3: a presigned URL, so the bytes go straight from the bucket and never
   * pass through this process. This is the entire reason S3 is worth
   * supporting for a large library — without it every download would still
   * work (createReadStream falls through below) but would burn a Node
   * connection re-streaming what S3 would have served directly.
   */
  if (location.backend === 's3') {
    const delivery = await storage.downloadUrl(relativePath, filename)
    if (delivery.kind === 'redirect') {
      return new Response(null, { status: 302, headers: { location: delivery.url } })
    }
  }

  /*
   * Hand off to nginx. It serves the file with sendfile and handles Range
   * itself, so nothing here needs to parse the header — the proxy is better at
   * this than we are, and the bytes never enter this process.
   */
  if (process.env.FILE_DELIVERY === 'xaccel' && location.path) {
    /*
     * Resolved against the mounts nginx actually serves. The redirect has to
     * carry the path relative to the MOUNT, not to the library — otherwise a
     * library at /libraries/prints asks nginx for /libraries/<file> and every
     * download 404s. Null means the file is under no known mount, so fall
     * through to streaming rather than emit something nginx cannot resolve.
     */
    const redirect = accelRedirectPath(location.path, relativePath, accelMounts())
    if (redirect) {
      return new Response(null, {
        status: 200,
        headers: { ...baseHeaders, 'x-accel-redirect': redirect },
      })
    }
  }

  const range = parseRange(request.headers.get('range'), info.size)

  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { ...baseHeaders, 'content-range': `bytes */${info.size}` },
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
        ...baseHeaders,
        'content-range': `bytes ${range.start}-${range.end}/${info.size}`,
        'content-length': String(range.length),
      },
    })
  }

  const stream = await storage.createReadStream(relativePath)
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: { ...baseHeaders, 'content-length': String(info.size) },
  })
}

/**
 * A session, or a signed link.
 *
 * The session covers the browser. The signed link covers a desktop slicer,
 * which fetches this URL as a separate application and has none of our cookies
 * — see the open-in-slicer buttons on the model page. The signature names this
 * exact file and expires within minutes, so a link that leaks is not a
 * standing grant to the library.
 */
async function isAuthorised(request: Request, fileId: string): Promise<boolean> {
  const url = new URL(request.url)
  const token = url.searchParams.get('token')

  if (token) {
    const secret = process.env.BETTER_AUTH_SECRET
    const expires = Number(url.searchParams.get('expires'))
    if (secret && verifyToken(secret, 'file', fileId, token, expires)) return true
    // Fall through: an expired token from a signed-in browser should still work.
  }

  const user = await getSessionUser()
  return can({ id: user?.id ?? '', role: user?.role ?? null }, 'file:download')
}
