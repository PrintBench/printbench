import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { Server } from '@tus/server'
import { FileStore } from '@tus/file-store'
import { getDb, schema } from '@pm/db'
import {
  dirname,
  extensionOf,
  isSafeRelativePath,
  normalizePath,
  isIgnoredName,
  isIndexable,
  joinPath,
  stemOf,
} from '@pm/core'
import { JOB, getQueue } from '@pm/jobs'
import { extractZipIntoLibrary, ZipIngestError } from './zip-ingest'

/**
 * Resumable uploads, via the tus protocol.
 *
 * Resumability is not a luxury here. A single miniature can be several hundred
 * megabytes and a pack can be gigabytes; losing all of that to a dropped
 * connection at 90% is the difference between a usable feature and one nobody
 * trusts. tus resumes from the last confirmed byte.
 *
 * Runs in the worker for the same reason ZIP downloads do: a long upload should
 * not occupy the process that renders pages.
 *
 * Files land in a staging directory first and are moved into the library only
 * once complete, so a half-uploaded mesh is never visible to a scan.
 *
 * A .zip is the one exception to "moved as-is": it is extracted rather than
 * stored whole, via zip-ingest.ts. Everything else — resumability, the staging
 * directory, the scan trigger on completion — is identical either way.
 */

const UPLOAD_TOKEN_TTL_MS = 6 * 60 * 60 * 1000

export function signUploadToken(libraryId: string, expiresAt: number, secret: string): string {
  return createHmac('sha256', secret).update(`upload:${libraryId}:${expiresAt}`).digest('hex')
}

export function verifyUploadToken(
  libraryId: string,
  expiresAt: number,
  token: string,
  secret: string,
): boolean {
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false
  const expected = signUploadToken(libraryId, expiresAt, secret)
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(token, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

export const UPLOAD_TTL_MS = UPLOAD_TOKEN_TTL_MS

/**
 * Where an uploaded file is allowed to land.
 *
 * The relative path comes from the browser — from a folder drag-and-drop, so it
 * genuinely carries directory structure worth preserving — and is therefore
 * fully untrusted. Every segment is checked, and the storage adapter checks
 * again when it actually writes.
 */
export function sanitizeUploadPath(relativePath: string): string | null {
  /*
   * Validate the RAW input before normalising it.
   *
   * normalizePath strips leading slashes, so checking afterwards would see
   * "/etc/passwd.stl" as the perfectly ordinary relative path "etc/passwd.stl"
   * and accept it. Silently reinterpreting an absolute path as a relative one
   * is the wrong answer even when the result stays inside the library.
   */
  if (!isSafeRelativePath(relativePath)) return null

  const normalized = normalizePath(relativePath)
  if (!normalized || !isSafeRelativePath(normalized)) return null
  if (normalized.length > 1000) return null

  const segments = normalized.split('/')
  if (segments.length > 12) return null
  // Rubbish the scanner would ignore anyway, and dotfiles that could shadow our
  // own sidecar.
  if (segments.some((segment) => isIgnoredName(segment))) return null
  // Only formats the library is willing to index. Anything else is a mystery
  // file taking up space with no way to view or search it.
  if (!isIndexable(normalized)) return null

  return normalized
}

let server: Server | undefined

function getServer(stagingDir: string): Server {
  server ??= new Server({
    path: '/api/upload',
    datastore: new FileStore({ directory: stagingDir }),
    // 8 GB. Larger than any single mesh anyone reasonably has, small enough
    // that a runaway client cannot fill the disk.
    maxSize: 8 * 1024 * 1024 * 1024,
    respectForwardedHeaders: true,

    /*
     * Carry the auth query string onto the per-upload URL.
     *
     * tus normally returns a bare `/api/upload/<id>` for subsequent chunks,
     * which drops the token that authorised the upload — so every PATCH after
     * the first would arrive unauthenticated. The alternative is to check the
     * token only at creation and treat the upload id as a bearer capability,
     * which is weaker: this keeps every request authorised.
     */
    generateUrl(request, { proto, host, path: basePath, id }) {
      const query = (request.url ?? '').split('?')[1]
      const url = `${proto}://${host}${basePath}/${id}`
      return query ? `${url}?${query}` : url
    },

    /*
     * The id is the last path segment, ignoring the query string. Without this
     * the default extractor treats "abc123?library=..." as the id and no upload
     * is ever found.
     */
    getFileIdFromRequest(request, lastPath) {
      const candidate = lastPath ?? (request.url ?? '').split('/').pop() ?? ''
      const id = candidate.split('?')[0] ?? ''
      return id.length > 0 ? decodeURIComponent(id) : undefined
    },

    async onIncomingRequest(request) {
      // Authorisation happens once, before any bytes are accepted.
      const secret = process.env.BETTER_AUTH_SECRET
      if (!secret) throw { status_code: 500, body: 'Uploads are not configured' }

      const url = new URL(request.url ?? '/', 'http://localhost')
      const libraryId = url.searchParams.get('library') ?? ''
      const expires = Number(url.searchParams.get('expires') ?? 0)
      const token = url.searchParams.get('token') ?? ''

      if (!/^[0-9a-f-]{36}$/i.test(libraryId)) {
        throw { status_code: 403, body: 'Invalid upload link' }
      }
      if (!verifyUploadToken(libraryId, expires, token, secret)) {
        throw { status_code: 403, body: 'Invalid or expired upload link' }
      }
    },

    async onUploadFinish(request, upload) {
      await ingest(upload.id, upload.metadata ?? {}, stagingDir)
      return {}
    },
  })
  return server
}

/**
 * Moves a finished upload into its library and queues it for indexing.
 *
 * Only reached once tus has the complete file, so a scan never sees a partial
 * mesh.
 */
async function ingest(
  uploadId: string,
  metadata: Record<string, string | null>,
  stagingDir: string,
): Promise<void> {
  const libraryId = metadata.libraryId ?? ''
  const relativePath = sanitizeUploadPath(metadata.relativePath ?? metadata.filename ?? '')

  if (!relativePath) {
    console.warn(`[upload] rejecting ${uploadId}: unusable path`)
    await rm(path.join(stagingDir, uploadId), { force: true })
    return
  }

  const db = getDb()
  const rows = await db
    .select()
    .from(schema.libraries)
    .where(eq(schema.libraries.id, libraryId))
    .limit(1)

  const library = rows[0]
  if (!library || library.backend !== 'local' || !library.path) {
    console.warn(`[upload] library ${libraryId} cannot receive uploads`)
    return
  }
  if (library.kind !== 'managed' && !library.allowWrites) {
    // The promise that in-place libraries are read-only holds for uploads too.
    console.warn(`[upload] refusing to write into read-only library ${library.name}`)
    await rm(path.join(stagingDir, uploadId), { force: true })
    return
  }

  const staged = path.join(stagingDir, uploadId)

  /*
   * A zip is unpacked, never stored whole — nobody can browse into an opaque
   * archive sitting in their library, and this is the only way to bulk-upload
   * a Thingiverse-style download or an existing collection without unzipping
   * it locally first. The extractor owns its own zip-slip guard; this call
   * site only decides WHERE the result goes.
   */
  if (extensionOf(relativePath) === 'zip') {
    const destRelativePath = joinPath(dirname(relativePath), stemOf(relativePath))
    try {
      const result = await extractZipIntoLibrary(staged, library.path, destRelativePath)
      console.log(
        `[upload] extracted ${result.filesExtracted} file(s) from ${relativePath} into "${library.name}"`,
      )
    } catch (error) {
      const reason = error instanceof ZipIngestError ? error.message : String(error)
      console.warn(`[upload] could not extract ${relativePath}: ${reason}`)
      return
    } finally {
      await rm(staged, { force: true })
      await rm(`${staged}.json`, { force: true })
    }

    await getQueue().send(
      JOB.libraryScan,
      { libraryId: library.id, mode: 'fast', force: false },
      { singletonKey: `scan:${library.id}` },
    )
    return
  }

  const destination = path.join(library.path, relativePath)
  const resolved = path.resolve(destination)
  const root = path.resolve(library.path)
  // Belt and braces alongside sanitizeUploadPath: this is the last point before
  // a write, and the cost of being wrong is writing outside the library.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    console.error(`[upload] refusing path escaping the library: ${relativePath}`)
    await rm(path.join(stagingDir, uploadId), { force: true })
    return
  }

  await mkdir(path.dirname(resolved), { recursive: true })

  try {
    await rename(staged, resolved)
  } catch (error) {
    // rename fails across filesystems; fall back to a copy.
    if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
      const { copyFile } = await import('node:fs/promises')
      await copyFile(staged, resolved)
      await rm(staged, { force: true })
    } else {
      throw error
    }
  }
  // tus keeps a .json alongside the payload.
  await rm(`${staged}.json`, { force: true })

  const size = (await stat(resolved).catch(() => null))?.size ?? 0
  console.log(`[upload] stored ${relativePath} (${size} bytes) in "${library.name}"`)

  /*
   * A scan rather than a direct insert. The scan already knows how to group
   * folders into models, pick a preview and queue thumbnails — duplicating any
   * of that here would be a second implementation to keep in step.
   */
  await getQueue().send(
    JOB.libraryScan,
    { libraryId: library.id, mode: 'fast', force: false },
    { singletonKey: `scan:${library.id}` },
  )
}

export function handleUploadRequest(
  request: IncomingMessage,
  response: ServerResponse,
  stagingDir: string,
): void {
  getServer(stagingDir).handle(request, response)
}
