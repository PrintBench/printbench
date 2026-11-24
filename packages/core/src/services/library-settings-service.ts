import { eq } from 'drizzle-orm'
import type { Database } from '@pb/db'
import { schema } from '@pb/db'
import {
  checkLocation,
  findS3LibraryAt,
  loadS3ConnectionForCheck,
  normalizeS3Prefix,
  s3CheckLocation,
  type LocationCheck,
  type ServiceResult,
} from './s3-connection-service'

/**
 * Creating an S3 library, and changing a library after it exists.
 *
 * What can change after creation is deliberately narrow. A library's
 * location — its folder, its bucket, its prefix — is what every indexed path
 * is relative to, so moving it would make each model look missing at the next
 * scan, and the scan's safety guard would (rightly) refuse to run. Grouping is
 * fixed for the same reason: a different grouping is a different set of
 * models. The name, the sidecar setting and which credentials reach the
 * bucket are safe to change, so those are what is offered.
 */

export interface NewS3Library {
  name: string
  kind: 'in_place' | 'managed'
  connectionId: string
  prefix?: string | null
  groupingMode: 'deepest' | 'top_level' | 'flat'
  groupingDepth?: number | null
  writeSidecar: boolean
}

/**
 * Checks a connection and prefix can be read and are not already indexed,
 * returning the location to preview or create from.
 */
export async function resolveS3LibraryLocation(
  db: Database,
  input: { connectionId: string; prefix?: string | null; kind: 'in_place' | 'managed' },
  options: { check?: LocationCheck; exceptLibraryId?: string } = {},
): Promise<ServiceResult<{ prefix: string | null; location: ReturnType<typeof s3CheckLocation> }>> {
  if (!input.connectionId) return { ok: false, error: 'Choose an S3 connection.' }

  const connection = await loadS3ConnectionForCheck(db, input.connectionId)
  if (!connection.ok) return connection

  const prefix = normalizeS3Prefix(input.prefix)
  const clash = await findS3LibraryAt(
    db,
    { bucket: connection.data.bucket, endpoint: connection.data.endpoint, prefix },
    options.exceptLibraryId,
  )
  if (clash) {
    return {
      ok: false,
      error: `“${clash.name}” already indexes ${prefix ? `${prefix}/ in` : 'the whole of'} that bucket.`,
    }
  }

  const location = {
    ...s3CheckLocation(connection.data, prefix),
    kind: input.kind,
    allowWrites: input.kind === 'managed',
  }
  const health = await (options.check ?? checkLocation)(location)
  if (!health.ok) return { ok: false, error: health.reason ?? 'That bucket is not readable.' }

  return { ok: true, data: { prefix, location } }
}

export async function createS3Library(
  db: Database,
  input: NewS3Library,
  options: { check?: LocationCheck } = {},
): Promise<ServiceResult<{ id: string; name: string }>> {
  const name = input.name.trim()
  if (!name) return { ok: false, error: 'Give the library a name.' }

  const resolved = await resolveS3LibraryLocation(db, input, options)
  if (!resolved.ok) return resolved

  const [created] = await db
    .insert(schema.libraries)
    .values({
      name,
      kind: input.kind,
      backend: 's3',
      // An uploads library exists to be written to; a bucket of files the
      // user already had keeps the same read-only promise as a folder.
      allowWrites: input.kind === 'managed',
      s3ConnectionId: input.connectionId,
      s3Prefix: resolved.data.prefix,
      groupingMode: input.groupingMode,
      groupingDepth: input.groupingDepth ?? null,
      writeSidecar: input.writeSidecar,
    })
    .returning({ id: schema.libraries.id, name: schema.libraries.name })

  return { ok: true, data: created! }
}

export interface LibrarySettings {
  name: string
  writeSidecar: boolean
  /** S3 libraries only. Must reach the same bucket as the current one. */
  s3ConnectionId?: string | null
}

export interface LibrarySettingsChange {
  name: string
  previousName: string
  /** Field names that changed, for the audit log. */
  changed: string[]
}

export async function updateLibrarySettings(
  db: Database,
  libraryId: string,
  input: LibrarySettings,
  options: { check?: LocationCheck } = {},
): Promise<ServiceResult<LibrarySettingsChange>> {
  const name = input.name.trim()
  if (!name) return { ok: false, error: 'Give the library a name.' }

  const [library] = await db
    .select({
      id: schema.libraries.id,
      name: schema.libraries.name,
      kind: schema.libraries.kind,
      backend: schema.libraries.backend,
      writeSidecar: schema.libraries.writeSidecar,
      s3ConnectionId: schema.libraries.s3ConnectionId,
      s3Prefix: schema.libraries.s3Prefix,
      currentBucket: schema.s3Connections.bucket,
    })
    .from(schema.libraries)
    .leftJoin(schema.s3Connections, eq(schema.s3Connections.id, schema.libraries.s3ConnectionId))
    .where(eq(schema.libraries.id, libraryId))
    .limit(1)
  if (!library) return { ok: false, error: 'That library no longer exists.' }

  const changed: string[] = []
  if (name !== library.name) changed.push('name')
  if (input.writeSidecar !== library.writeSidecar) changed.push('writeSidecar')

  const wantsConnection = input.s3ConnectionId ?? library.s3ConnectionId
  if (wantsConnection !== library.s3ConnectionId) {
    if (library.backend !== 's3') {
      return { ok: false, error: 'Only an S3 library uses a connection.' }
    }
    if (!wantsConnection) return { ok: false, error: 'Choose an S3 connection.' }

    const next = await loadS3ConnectionForCheck(db, wantsConnection)
    if (!next.ok) return next

    /*
     * Same bucket only. Switching connections is for changing which
     * credentials reach the files — consolidating onto a shared key, say —
     * not for moving the library somewhere else, which the scan would see as
     * every model going missing at once.
     */
    if (library.currentBucket !== null && next.data.bucket !== library.currentBucket) {
      return {
        ok: false,
        error: `That connection is for the bucket “${next.data.bucket}”, but this library’s files are in “${library.currentBucket}”. Choose a connection to the same bucket.`,
      }
    }

    const resolved = await resolveS3LibraryLocation(
      db,
      { connectionId: wantsConnection, prefix: library.s3Prefix, kind: library.kind },
      { ...options, exceptLibraryId: library.id },
    )
    if (!resolved.ok) return { ok: false, error: `Nothing was saved. ${resolved.error}` }
    changed.push('s3Connection')
  }

  if (changed.length > 0) {
    await db
      .update(schema.libraries)
      .set({
        name,
        writeSidecar: input.writeSidecar,
        s3ConnectionId: wantsConnection,
        updatedAt: new Date(),
      })
      .where(eq(schema.libraries.id, libraryId))
  }

  return { ok: true, data: { name, previousName: library.name, changed } }
}
