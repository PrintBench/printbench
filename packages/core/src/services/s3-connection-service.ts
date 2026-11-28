import { and, asc, eq, ne, sql } from 'drizzle-orm'
import type { Database } from '@pb/db'
import { schema } from '@pb/db'
import { decryptSecret, encryptSecret } from '../security/secret-box'
import {
  createStorageAdapter,
  libraryLocationFromRow,
  type LibraryRow,
  type S3ConnectionRow,
} from '../storage/factory'
import { detectS3Provider } from '../storage/provider'
import type { LibraryLocation } from '../storage/types'

/**
 * S3 connections: a bucket and the credentials that reach it, configured once
 * and shared by every library that indexes part of that bucket.
 *
 * Before these existed each S3 library carried its own copy of the key, so a
 * bucket carved into five libraries meant typing the secret five times — and
 * revoking it meant finding all five. A connection is the one place to rotate
 * or remove a key; the libraries on it pick up the change on their next
 * request, because nothing caches a location past a single job or request.
 */

/**
 * The connection an S3 library uses, or null for a local library (or an S3
 * library whose connection is missing, which the adapter then refuses).
 */
export async function s3ConnectionFor(
  db: Database,
  library: Pick<LibraryRow, 'backend' | 's3ConnectionId'>,
): Promise<S3ConnectionRow | null> {
  if (library.backend !== 's3' || !library.s3ConnectionId) return null
  const [connection] = await db
    .select({
      bucket: schema.s3Connections.bucket,
      endpoint: schema.s3Connections.endpoint,
      region: schema.s3Connections.region,
      accessKeyId: schema.s3Connections.accessKeyId,
      secretAccessKey: schema.s3Connections.secretAccessKey,
      forcePathStyle: schema.s3Connections.forcePathStyle,
    })
    .from(schema.s3Connections)
    .where(eq(schema.s3Connections.id, library.s3ConnectionId))
    .limit(1)
  return connection ?? null
}

/**
 * A library's location, with its S3 connection looked up.
 *
 * Read fresh every time rather than cached, so a key rotated or withdrawn on
 * the connection takes effect at the next request or job, everywhere.
 */
export async function resolveLibraryLocation(db: Database, library: LibraryRow) {
  return libraryLocationFromRow(library, await s3ConnectionFor(db, library))
}

export type ServiceResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string }

/** What a health check reports. Injected in tests, which have no bucket. */
export type LocationCheck = (location: LibraryLocation) => Promise<{ ok: boolean; reason?: string }>

export const checkLocation: LocationCheck = async (location) => {
  const storage = createStorageAdapter(location)
  try {
    return await storage.healthCheck()
  } finally {
    ;(storage as { destroy?: () => void }).destroy?.()
  }
}

export interface S3ConnectionInput {
  name: string
  bucket: string
  endpoint?: string | null
  region?: string | null
  accessKeyId?: string | null
  /**
   * On update, blank keeps the stored secret: it is never sent back to the
   * browser, so the form has nothing to pre-fill it with.
   */
  secretAccessKey?: string | null
  forcePathStyle?: boolean | null
}

export interface S3ConnectionSummary {
  id: string
  name: string
  bucket: string
  endpoint: string | null
  region: string | null
  /** Who runs the bucket, worked out from the endpoint: "Backblaze B2", "MinIO", or the host. */
  provider: string
  accessKeyId: string | null
  /** Whether a secret is stored. The secret itself never leaves the server. */
  hasSecret: boolean
  /** A stored secret that no longer decrypts — BETTER_AUTH_SECRET was rotated. */
  secretUnreadable: boolean
  forcePathStyle: boolean
  libraries: { id: string; name: string; prefix: string | null }[]
}

/**
 * The prefix as the adapter will use it: no leading or trailing slashes, and
 * null for "the whole bucket".
 *
 * Stored in this form so that "models", "/models/" and "models/" are one
 * prefix when checking whether two libraries overlap, rather than three.
 */
export function normalizeS3Prefix(prefix: string | null | undefined): string | null {
  const clean = (prefix ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '')
  return clean === '' ? null : clean
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}

interface CleanInput {
  name: string
  bucket: string
  endpoint: string | null
  region: string | null
  accessKeyId: string | null
  secretAccessKey: string | null
  forcePathStyle: boolean
}

function clean(input: S3ConnectionInput): ServiceResult<CleanInput> {
  const name = input.name.trim()
  if (!name) return { ok: false, error: 'Give the connection a name.' }
  if (name.length > 100) return { ok: false, error: 'Keep the name under 100 characters.' }

  const bucket = input.bucket.trim()
  if (!bucket) return { ok: false, error: 'Give the bucket a name.' }

  const endpoint = blankToNull(input.endpoint)
  if (endpoint) {
    const url = URL.canParse(endpoint) ? new URL(endpoint) : null
    if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
      return {
        ok: false,
        error: 'The endpoint must be a full URL, like https://minio.example.com.',
      }
    }
  }

  return {
    ok: true,
    data: {
      name,
      bucket,
      endpoint,
      region: blankToNull(input.region),
      accessKeyId: blankToNull(input.accessKeyId),
      // Not trimmed: a secret is whatever the provider issued, spaces and all.
      secretAccessKey: input.secretAccessKey ? input.secretAccessKey : null,
      /*
       * MinIO and most self-hosted gateways cannot do virtual-host addressing,
       * so a custom endpoint means path style unless told otherwise.
       */
      forcePathStyle: input.forcePathStyle ?? Boolean(endpoint),
    },
  }
}

/** A location to health-check: the connection's bucket, at one prefix. */
export function s3CheckLocation(
  connection: Pick<
    CleanInput,
    'bucket' | 'endpoint' | 'region' | 'accessKeyId' | 'secretAccessKey' | 'forcePathStyle'
  >,
  prefix: string | null,
): LibraryLocation {
  return {
    id: 'check',
    kind: 'in_place',
    backend: 's3',
    allowWrites: false,
    s3Bucket: connection.bucket,
    s3Prefix: prefix,
    s3Endpoint: connection.endpoint,
    s3Region: connection.region,
    s3AccessKeyId: connection.accessKeyId,
    s3SecretAccessKey: connection.secretAccessKey,
    s3ForcePathStyle: connection.forcePathStyle,
  }
}

async function nameTaken(db: Database, name: string, exceptId?: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.s3Connections.id })
    .from(schema.s3Connections)
    .where(
      and(
        sql`lower(${schema.s3Connections.name}) = lower(${name})`,
        exceptId ? ne(schema.s3Connections.id, exceptId) : undefined,
      ),
    )
    .limit(1)
  return rows.length > 0
}

/**
 * The library already indexing this bucket and prefix, if any.
 *
 * Compared by bucket, endpoint and normalised prefix across every connection,
 * not just one: two connections with different keys for the same bucket are
 * still the same files, and two libraries indexing them would show every
 * model twice. Prefixes are compared in code because rows saved before they
 * were normalised may still carry slashes.
 */
export async function findS3LibraryAt(
  db: Database,
  where: { bucket: string; endpoint: string | null; prefix: string | null },
  exceptLibraryId?: string,
): Promise<{ id: string; name: string } | null> {
  const rows = await db
    .select({
      id: schema.libraries.id,
      name: schema.libraries.name,
      prefix: schema.libraries.s3Prefix,
      endpoint: schema.s3Connections.endpoint,
    })
    .from(schema.libraries)
    .innerJoin(schema.s3Connections, eq(schema.s3Connections.id, schema.libraries.s3ConnectionId))
    .where(eq(schema.s3Connections.bucket, where.bucket))

  const prefix = normalizeS3Prefix(where.prefix)
  const match = rows.find(
    (row) =>
      row.id !== exceptLibraryId &&
      (row.endpoint ?? null) === (where.endpoint ?? null) &&
      normalizeS3Prefix(row.prefix) === prefix,
  )
  return match ? { id: match.id, name: match.name } : null
}

/** Every connection, with the libraries using it. Secrets are never included. */
export async function listS3Connections(db: Database): Promise<S3ConnectionSummary[]> {
  const connections = await db
    .select()
    .from(schema.s3Connections)
    .orderBy(asc(schema.s3Connections.name))

  const libraries = await db
    .select({
      id: schema.libraries.id,
      name: schema.libraries.name,
      prefix: schema.libraries.s3Prefix,
      connectionId: schema.libraries.s3ConnectionId,
    })
    .from(schema.libraries)
    .where(sql`${schema.libraries.s3ConnectionId} IS NOT NULL`)
    .orderBy(asc(schema.libraries.name))

  return connections.map((connection) => ({
    id: connection.id,
    name: connection.name,
    bucket: connection.bucket,
    endpoint: connection.endpoint,
    region: connection.region,
    provider: detectS3Provider(connection.endpoint).name,
    accessKeyId: connection.accessKeyId,
    hasSecret: connection.secretAccessKey !== null,
    secretUnreadable:
      connection.secretAccessKey !== null && decryptSecret(connection.secretAccessKey) === null,
    forcePathStyle: connection.forcePathStyle,
    libraries: libraries
      .filter((library) => library.connectionId === connection.id)
      .map(({ id, name, prefix }) => ({ id, name, prefix })),
  }))
}

/**
 * Adds a connection, after checking the bucket answers with these credentials.
 *
 * Checked at the root of the bucket, because no library has chosen a prefix
 * yet. A key scoped to one prefix by IAM can fail that check even though it
 * would work for a library; the library form checks its own prefix again.
 */
export async function createS3Connection(
  db: Database,
  input: S3ConnectionInput,
  options: { check?: LocationCheck } = {},
): Promise<ServiceResult<{ id: string; name: string }>> {
  const cleaned = clean(input)
  if (!cleaned.ok) return cleaned
  const value = cleaned.data

  if (Boolean(value.accessKeyId) !== Boolean(value.secretAccessKey)) {
    return {
      ok: false,
      error:
        'Enter both the access key ID and the secret, or leave both blank to use the server’s own credentials.',
    }
  }
  if (await nameTaken(db, value.name)) {
    return { ok: false, error: 'Another connection already has that name.' }
  }

  const health = await (options.check ?? checkLocation)(s3CheckLocation(value, null))
  if (!health.ok) return { ok: false, error: health.reason ?? 'That bucket is not reachable.' }

  const [created] = await db
    .insert(schema.s3Connections)
    .values({
      name: value.name,
      bucket: value.bucket,
      endpoint: value.endpoint,
      region: value.region,
      accessKeyId: value.accessKeyId,
      // Encrypted at rest, like every other stored credential.
      secretAccessKey: value.secretAccessKey ? encryptSecret(value.secretAccessKey) : null,
      forcePathStyle: value.forcePathStyle,
    })
    .returning({ id: schema.s3Connections.id, name: schema.s3Connections.name })

  return { ok: true, data: created! }
}

export interface S3ConnectionChange {
  name: string
  /** Field names that changed, for the audit log. Never the values of secrets. */
  changed: string[]
  libraryCount: number
}

/**
 * Changes a connection — most often to rotate its key, which is the point of
 * having one place for it.
 *
 * The new settings are checked against every library on the connection, at
 * that library's own prefix, before anything is saved: a rotated key that
 * cannot read one of them would otherwise only show up as that library's next
 * scan failing.
 *
 * The bucket is fixed while libraries use the connection. Changing it would
 * point every one of them at different files, and the next scan would see the
 * whole library as missing. The endpoint may change (a gateway that moved
 * host still holds the same files), as may the region and credentials.
 */
export async function updateS3Connection(
  db: Database,
  id: string,
  input: S3ConnectionInput,
  options: { check?: LocationCheck } = {},
): Promise<ServiceResult<S3ConnectionChange>> {
  const cleaned = clean(input)
  if (!cleaned.ok) return cleaned
  const value = cleaned.data

  const [current] = await db
    .select()
    .from(schema.s3Connections)
    .where(eq(schema.s3Connections.id, id))
    .limit(1)
  if (!current) return { ok: false, error: 'That connection no longer exists.' }

  if (await nameTaken(db, value.name, id)) {
    return { ok: false, error: 'Another connection already has that name.' }
  }

  const libraries = await db
    .select({
      id: schema.libraries.id,
      name: schema.libraries.name,
      prefix: schema.libraries.s3Prefix,
    })
    .from(schema.libraries)
    .where(eq(schema.libraries.s3ConnectionId, id))

  if (libraries.length > 0 && value.bucket !== current.bucket) {
    return {
      ok: false,
      error: `The bucket cannot change while ${libraries.length === 1 ? 'a library uses' : `${libraries.length} libraries use`} this connection. Their models would all look missing. Add a new connection for the other bucket instead.`,
    }
  }

  /*
   * Working out the secret to keep. Blank keeps the stored one, unless the
   * access key itself changed — a new key with the old key's secret is never
   * what anyone meant, and failing the health check would be a worse way to
   * say so. No access key at all means the SDK's own chain, so both go.
   */
  let encrypted: string | null
  let plaintext: string | null
  if (!value.accessKeyId) {
    encrypted = null
    plaintext = null
  } else if (value.secretAccessKey) {
    encrypted = encryptSecret(value.secretAccessKey)
    plaintext = value.secretAccessKey
  } else if (value.accessKeyId === current.accessKeyId && current.secretAccessKey) {
    plaintext = decryptSecret(current.secretAccessKey)
    if (plaintext === null) {
      return {
        ok: false,
        error:
          'The stored secret can no longer be read (BETTER_AUTH_SECRET has changed). Enter it again.',
      }
    }
    encrypted = current.secretAccessKey
  } else {
    return { ok: false, error: 'Enter the secret access key for the new access key ID.' }
  }

  const next = { ...value, secretAccessKey: plaintext }

  if (value.endpoint !== current.endpoint) {
    for (const library of libraries) {
      const clash = await findS3LibraryAt(
        db,
        { bucket: value.bucket, endpoint: value.endpoint, prefix: library.prefix },
        library.id,
      )
      if (clash) {
        return {
          ok: false,
          error: `“${library.name}” would then index the same files as “${clash.name}”.`,
        }
      }
    }
  }

  const check = options.check ?? checkLocation
  const prefixes = libraries.length > 0 ? libraries.map((library) => library.prefix) : [null]
  for (const prefix of prefixes) {
    const health = await check(s3CheckLocation(next, normalizeS3Prefix(prefix)))
    if (!health.ok) {
      const library = libraries.find((candidate) => candidate.prefix === prefix)
      const reason = health.reason ?? 'That bucket is not reachable.'
      return {
        ok: false,
        error: library
          ? `Nothing was saved. “${library.name}” could not be read: ${reason}`
          : reason,
      }
    }
  }

  const changed: string[] = []
  if (value.name !== current.name) changed.push('name')
  if (value.bucket !== current.bucket) changed.push('bucket')
  if (value.endpoint !== current.endpoint) changed.push('endpoint')
  if (value.region !== current.region) changed.push('region')
  if (value.accessKeyId !== current.accessKeyId) changed.push('accessKeyId')
  if (encrypted !== current.secretAccessKey) changed.push('secretAccessKey')
  if (value.forcePathStyle !== current.forcePathStyle) changed.push('forcePathStyle')

  await db
    .update(schema.s3Connections)
    .set({
      name: value.name,
      bucket: value.bucket,
      endpoint: value.endpoint,
      region: value.region,
      accessKeyId: value.accessKeyId,
      secretAccessKey: encrypted,
      forcePathStyle: value.forcePathStyle,
      updatedAt: new Date(),
    })
    .where(eq(schema.s3Connections.id, id))

  return { ok: true, data: { name: value.name, changed, libraryCount: libraries.length } }
}

/**
 * Removes a connection, which is how access is withdrawn in one step.
 *
 * Refused while any library still uses it, rather than taking the libraries
 * down with it: removing a credential should never be a quiet way to delete
 * an index. The foreign key refuses it too; this says why in words.
 */
export async function deleteS3Connection(
  db: Database,
  id: string,
): Promise<ServiceResult<{ name: string }>> {
  const users = await db
    .select({ name: schema.libraries.name })
    .from(schema.libraries)
    .where(eq(schema.libraries.s3ConnectionId, id))
    .orderBy(asc(schema.libraries.name))

  if (users.length > 0) {
    const names = users.map((library) => `“${library.name}”`).join(', ')
    return {
      ok: false,
      error: `Still used by ${names}. Move ${users.length === 1 ? 'that library' : 'those libraries'} to another connection, or remove ${users.length === 1 ? 'it' : 'them'}, first.`,
    }
  }

  // The foreign key would refuse this too, but as an error nobody can act on.
  const [backups] = await db
    .select({ id: schema.backupSchedule.id })
    .from(schema.backupSchedule)
    .where(eq(schema.backupSchedule.s3ConnectionId, id))
    .limit(1)
  if (backups) {
    return {
      ok: false,
      error:
        'Scheduled backups go to this connection. Point them somewhere else under Backup first.',
    }
  }

  const [removed] = await db
    .delete(schema.s3Connections)
    .where(eq(schema.s3Connections.id, id))
    .returning({ name: schema.s3Connections.name })
  if (!removed) return { ok: false, error: 'That connection no longer exists.' }

  return { ok: true, data: removed }
}

/**
 * A connection's settings with its secret decrypted, ready to check or to
 * build a library location from. Server-side only.
 */
export async function loadS3ConnectionForCheck(
  db: Database,
  id: string,
): Promise<ServiceResult<Parameters<typeof s3CheckLocation>[0]>> {
  const [connection] = await db
    .select()
    .from(schema.s3Connections)
    .where(eq(schema.s3Connections.id, id))
    .limit(1)
  if (!connection) return { ok: false, error: 'Choose an S3 connection.' }

  const secretAccessKey = decryptSecret(connection.secretAccessKey)
  if (connection.secretAccessKey && secretAccessKey === null) {
    return {
      ok: false,
      error: `The secret stored for “${connection.name}” can no longer be read. Re-enter it under Storage.`,
    }
  }

  return {
    ok: true,
    data: {
      bucket: connection.bucket,
      endpoint: connection.endpoint,
      region: connection.region,
      accessKeyId: connection.accessKeyId,
      secretAccessKey,
      forcePathStyle: connection.forcePathStyle,
    },
  }
}
