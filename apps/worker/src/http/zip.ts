import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { eq, isNull, and } from 'drizzle-orm'
import { ZipArchive, type ArchiverError } from 'archiver'
import { getDb, schema } from '@pb/db'
import { contentDisposition, createStorageAdapter, libraryLocationFromRow } from '@pb/core'

/**
 * Streams a whole model as a ZIP.
 *
 * Served from the worker rather than the web process: building an 8 GB archive
 * occupies a thread for minutes, and doing that in the request path of the
 * page-rendering process makes the whole UI stutter.
 *
 * The archive is streamed, never buffered — entries are appended as they are
 * read, with chunked transfer encoding and no Content-Length. A user can start
 * downloading immediately instead of waiting for the whole thing to be built.
 */

/** STORE, not DEFLATE. */
const ZIP_LEVEL = 0

/**
 * The worker has no session cookie and no auth stack — auth is a web-tier
 * concern. The web process therefore signs a short-lived token naming the
 * model, and the worker verifies it. This keeps the two processes independent
 * while making the endpoint impossible to call without having been authorised.
 */
export function signDownloadToken(modelId: string, expiresAt: number, secret: string): string {
  return createHmac('sha256', secret).update(`${modelId}:${expiresAt}`).digest('hex')
}

export function verifyDownloadToken(
  modelId: string,
  expiresAt: number,
  token: string,
  secret: string,
): boolean {
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false

  const expected = signDownloadToken(modelId, expiresAt, secret)
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(token, 'utf8')
  // Constant-time, and length-checked first because timingSafeEqual throws on
  // a length mismatch.
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function handleZipRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const modelId = url.searchParams.get('model') ?? ''
  const expiresAt = Number(url.searchParams.get('expires') ?? 0)
  const token = url.searchParams.get('token') ?? ''

  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret) {
    response.writeHead(500, { 'content-type': 'text/plain' })
    response.end('Server is not configured for downloads')
    return
  }

  if (
    !/^[0-9a-f-]{36}$/i.test(modelId) ||
    !verifyDownloadToken(modelId, expiresAt, token, secret)
  ) {
    response.writeHead(403, { 'content-type': 'text/plain' })
    response.end('Invalid or expired download link')
    return
  }

  const db = getDb()
  const rows = await db
    .select({ model: schema.models, library: schema.libraries })
    .from(schema.models)
    .innerJoin(schema.libraries, eq(schema.libraries.id, schema.models.libraryId))
    .where(eq(schema.models.id, modelId))
    .limit(1)

  const row = rows[0]
  if (!row) {
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('Not found')
    return
  }

  const files = await db
    .select({ filename: schema.modelFiles.filename })
    .from(schema.modelFiles)
    .where(and(eq(schema.modelFiles.modelId, modelId), isNull(schema.modelFiles.missingAt)))

  if (files.length === 0) {
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('This model has no files')
    return
  }

  const storage = createStorageAdapter(libraryLocationFromRow(row.library))

  const safeName = row.model.name.replace(/[/\\]/g, '-') || 'model'

  /*
   * No Content-Length: the size is unknown until the archive is finished, and
   * computing it would mean building the whole thing in memory first — exactly
   * what streaming avoids.
   */
  response.writeHead(200, {
    'content-type': 'application/zip',
    'content-disposition': contentDisposition(`${safeName}.zip`, 'attachment'),
    'cache-control': 'no-store',
  })

  // archiver 8 exports classes rather than a default factory.
  const archive = new ZipArchive({ zlib: { level: ZIP_LEVEL }, store: true })

  archive.on('warning', (error: ArchiverError) => {
    // A vanished entry is a warning, not a failure: the archive is already
    // streaming and cannot be retracted, so log it and carry on.
    console.warn(`[zip] ${row.model.name}: ${error.message}`)
  })
  archive.on('error', (error: ArchiverError) => {
    console.error(`[zip] ${row.model.name} failed:`, error)
    response.destroy()
  })

  // If the client disconnects, stop reading the disk immediately.
  request.on('close', () => {
    if (!response.writableEnded) archive.abort()
  })

  archive.pipe(response)

  for (const file of files) {
    const relativePath = row.model.isFileModel
      ? row.model.path
      : `${row.model.path}/${file.filename}`
    try {
      const stream = await storage.createReadStream(relativePath)
      // Preserve the folder structure the user already has on disk.
      archive.append(stream, { name: file.filename })
    } catch (error) {
      console.warn(`[zip] skipping ${file.filename}: ${String(error)}`)
    }
  }

  await archive.finalize()
}

/**
 * Compression is deliberately off.
 *
 * STL is dense float data and 3MF is already a zip; deflating either spends
 * significant CPU for a percent or two. Storing is faster than the disk read
 * that feeds it, so the archive streams at full speed.
 */
export const COMPRESSION_LEVEL = ZIP_LEVEL
