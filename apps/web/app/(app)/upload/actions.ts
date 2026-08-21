'use server'

import { createHmac } from 'node:crypto'
import { eq, or } from 'drizzle-orm'
import { PolicyError, assertCan } from '@pm/core'
import { requireUser } from '@pm/auth'
import { getDb, schema } from '@pm/db'

/** Long enough for a multi-gigabyte upload on a slow connection. */
const UPLOAD_TTL_MS = 6 * 60 * 60 * 1000

export interface UploadTarget {
  id: string
  name: string
  /** "local" or "s3" — shown so it is obvious where a large upload is going. */
  backend: 'local' | 's3'
}

/**
 * Libraries that can actually receive an upload.
 *
 * Managed libraries always can. An in-place library only if writes were
 * explicitly enabled on it — the default promise is that we never write into
 * the user's own folders.
 *
 * A local library needs a path; an S3 one needs a bucket. Neither is
 * guaranteed by the schema (both columns are nullable, since each backend
 * uses a different one), so a library missing its own is skipped rather than
 * offered as a target that would fail at the last step.
 */
export async function listUploadTargets(): Promise<UploadTarget[]> {
  try {
    const user = await requireUser()
    assertCan({ id: user.id, role: user.role ?? null, banned: user.banned ?? false }, 'file:upload')
  } catch {
    return []
  }

  const rows = await getDb()
    .select({
      id: schema.libraries.id,
      name: schema.libraries.name,
      backend: schema.libraries.backend,
      path: schema.libraries.path,
      s3Bucket: schema.libraries.s3Bucket,
    })
    .from(schema.libraries)
    .where(or(eq(schema.libraries.kind, 'managed'), eq(schema.libraries.allowWrites, true)))

  return rows
    .filter((row) => (row.backend === 's3' ? Boolean(row.s3Bucket) : Boolean(row.path)))
    .map((row) => ({ id: row.id, name: row.name, backend: row.backend }))
}

type TicketResult =
  | { ok: true; endpoint: string; libraryId: string }
  | { ok: false; error: string }

/**
 * Mints a signed ticket for the worker's upload endpoint.
 *
 * Uploads are handled by the worker — a multi-gigabyte transfer should not
 * occupy the process rendering pages — and the worker has no session. So
 * authorisation happens here and is handed over as a short-lived HMAC naming
 * the library, which the worker verifies before accepting a single byte.
 */
export async function createUploadTicket(libraryId: string): Promise<TicketResult> {
  try {
    const user = await requireUser()
    assertCan({ id: user.id, role: user.role ?? null, banned: user.banned ?? false }, 'file:upload')

    const secret = process.env.BETTER_AUTH_SECRET
    if (!secret) return { ok: false, error: 'Uploads are not configured on this server.' }

    const rows = await getDb()
      .select({
        id: schema.libraries.id,
        kind: schema.libraries.kind,
        allowWrites: schema.libraries.allowWrites,
        backend: schema.libraries.backend,
      })
      .from(schema.libraries)
      .where(eq(schema.libraries.id, libraryId))
      .limit(1)

    const library = rows[0]
    if (!library) return { ok: false, error: 'That library no longer exists.' }
    if (library.kind !== 'managed' && !library.allowWrites) {
      // The read-only promise holds for uploads too.
      return { ok: false, error: 'That library is read-only.' }
    }

    const expires = Date.now() + UPLOAD_TTL_MS
    const token = createHmac('sha256', secret)
      .update(`upload:${library.id}:${expires}`)
      .digest('hex')

    return {
      ok: true,
      libraryId: library.id,
      // Relative: nginx routes /api/upload to the worker in production, and the
      // dev server proxies it, so the browser never needs to know the port.
      endpoint: `/api/upload?library=${library.id}&expires=${expires}&token=${token}`,
    }
  } catch (error) {
    if (error instanceof PolicyError) return { ok: false, error: 'Not permitted.' }
    return { ok: false, error: 'Could not start the upload.' }
  }
}
