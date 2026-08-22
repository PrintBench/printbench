import { Readable } from 'node:stream'
import { eq } from 'drizzle-orm'
import { getSessionUser } from '@pb/auth'
import {
  can,
  canOpenInSlicer,
  contentDisposition,
  createStorageAdapter,
  libraryLocationFromRow,
  verifyToken,
} from '@pb/core'
import { readObj, readPly, readStl, writeThreeMf } from '@pb/mesh/parse'
import { getDb, schema } from '@pb/db'

/**
 * Serves any mesh as a 3MF, converting on the way out.
 *
 * This exists for one reason. Bambu Studio's URL handler contains:
 *
 *   if (!extension.Contains(".3mf") && !extension.Contains(".3MF")) {
 *     msg = _L("Download failed, unknown file format."); return; }
 *
 * and that check runs *before* it downloads anything. So a `bambustudio://`
 * link pointing at an STL is refused without a single request reaching us,
 * however correct the file, the headers or the extension in the path. Handing
 * over a real 3MF is the only way the feature can work — and every other
 * slicer reads 3MF too, so one path serves them all.
 *
 * Converting is honest here rather than lossy: STL carries nothing but
 * geometry, which is exactly what a minimal 3MF carries. A coloured OBJ or PLY
 * does lose its colours, which is noted where the links are built.
 */

/** Converting holds the whole mesh in memory, so this is not for a 2GB scan. */
const MAX_SOURCE_BYTES = 256 * 1024 * 1024

export async function serveAs3mf(
  request: Request,
  fileId: string,
  /** "<expires>-<token>" when the signature travels in the path. */
  credential?: string,
): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) return new Response('Not found', { status: 404 })

  // Same two ways in as the raw route: a session, or a signed link — the
  // slicer is a separate application with none of our cookies.
  if (!(await isAuthorised(request, fileId, credential))) {
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

  /*
   * Always streamed through here, even for S3 — never a redirect to a
   * presigned URL. Bambu Studio names the saved file after the URL's last
   * path segment, and a presigned URL's query string is full of "?" and "&" —
   * exactly the illegal-Windows-filename bug this hand-off was already fixed
   * for once (see createSlicerLinks in print-actions.ts).
   */
  const storage = createStorageAdapter(libraryLocationFromRow(row.library))

  const relativePath = row.model.isFileModel
    ? row.model.path
    : `${row.model.path}/${row.file.filename}`

  const info = await storage.stat(relativePath).catch(() => null)
  if (!info) return new Response('File is no longer on disk', { status: 404 })
  if (info.size > MAX_SOURCE_BYTES) {
    return new Response('That mesh is too large to convert', { status: 413 })
  }

  const extension = row.file.extension.toLowerCase()

  /*
   * The same gate the UI uses to decide whether to show a link at all, so the
   * two cannot drift. They did once: STEP was offered and always failed here,
   * while PLY converted fine and was never offered.
   */
  if (!canOpenInSlicer(extension)) {
    return new Response(`Cannot hand a .${extension} file to a slicer`, { status: 415 })
  }

  const source = () => storage.createReadStream(relativePath) as Promise<Readable>

  /*
   * Already a 3MF: hand over the original bytes.
   *
   * Re-containerising would strip everything a project file carries beyond
   * geometry — plates, painted supports, filament assignments, per-object
   * settings — and hand back a bare mesh. The point of this route is to give
   * the slicer something it will accept, and an untouched 3MF is both
   * acceptable and better.
   */
  if (extension === '3mf') {
    const filename = row.file.filename.split('/').pop() ?? 'model.3mf'
    return new Response(Readable.toWeb(await source()) as ReadableStream, {
      headers: {
        'content-type': 'model/3mf',
        'content-disposition': contentDisposition(filename, 'attachment'),
        'content-length': String(info.size),
        'cache-control': 'private, no-store',
      },
    })
  }

  try {
    const converted = await writeThreeMf({
      each: async (visit) => {
        switch (extension) {
          case 'stl':
            await readStl(source, visit, { byteLength: info.size })
            return
          case 'obj':
            await readObj(source, visit)
            return
          case 'ply':
            await readPly(source, visit)
            return
          default:
            // Unreachable: canOpenInSlicer has already vetted the extension.
            throw new Error(`Cannot convert .${extension} to 3MF`)
        }
      },
    })

    const name = (row.file.filename.split('/').pop() ?? 'model').replace(/\.[^.]+$/, '')

    return new Response(converted.data as unknown as BodyInit, {
      headers: {
        'content-type': 'model/3mf',
        'content-disposition': contentDisposition(`${name}.3mf`, 'attachment'),
        'content-length': String(converted.data.byteLength),
        /*
         * Not cached. The conversion is deterministic, but the source file can
         * change on disk between scans and a stale 3MF would be silently wrong
         * — worse than converting again, which takes milliseconds.
         */
        'cache-control': 'private, no-store',
      },
    })
  } catch (error) {
    console.error(`[3mf] could not convert ${relativePath}:`, error)
    return new Response(error instanceof Error ? error.message : 'Could not convert that mesh', {
      status: 422,
    })
  }
}

async function isAuthorised(
  request: Request,
  fileId: string,
  credential?: string,
): Promise<boolean> {
  const secret = process.env.BETTER_AUTH_SECRET
  const url = new URL(request.url)

  /*
   * From the path first. The hyphen splits on the FIRST one only: the expiry
   * is decimal digits and the token is hex, so neither contains one, but
   * splitting greedily would break the moment either changed encoding.
   */
  if (secret && credential) {
    const divider = credential.indexOf('-')
    if (divider > 0) {
      const expires = Number(credential.slice(0, divider))
      const token = credential.slice(divider + 1)
      if (verifyToken(secret, 'file', fileId, token, expires)) return true
    }
  }

  // The query-string form, still used by anything built before the path form.
  const queryToken = url.searchParams.get('token')
  if (secret && queryToken) {
    const expires = Number(url.searchParams.get('expires'))
    if (verifyToken(secret, 'file', fileId, queryToken, expires)) return true
  }

  const user = await getSessionUser()
  return can({ id: user?.id ?? '', role: user?.role ?? null }, 'file:download')
}
