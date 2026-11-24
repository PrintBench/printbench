import { decryptSecret } from '../security/secret-box'
import { LocalAdapter } from './local-adapter'
import { S3Adapter } from './s3-adapter'
import type { LibraryLocation, StorageAdapter } from './types'

/**
 * Picks the right adapter for a library's backend.
 *
 * Every route that serves a file needs this, and before this existed each one
 * wrote its own `backend === 'local' ? ... : 501` — which is how S3 stayed
 * completely unreachable even after the adapter and its tests were written.
 */
export function createStorageAdapter(location: LibraryLocation): StorageAdapter {
  switch (location.backend) {
    case 'local':
      return new LocalAdapter(location)
    case 's3':
      return new S3Adapter(location)
    default:
      throw new Error(`Unknown storage backend: ${String(location.backend)}`)
  }
}

/** The `libraries` columns needed to build a `LibraryLocation`. */
export interface LibraryRow {
  id: string
  kind: 'in_place' | 'managed'
  backend: 'local' | 's3'
  allowWrites: boolean
  path: string | null
  s3ConnectionId?: string | null
  s3Prefix?: string | null
}

/** The `s3_connections` columns needed to build a `LibraryLocation`. */
export interface S3ConnectionRow {
  bucket: string
  endpoint: string | null
  region: string | null
  accessKeyId: string | null
  /** Still encrypted, exactly as stored. */
  secretAccessKey: string | null
  forcePathStyle: boolean
}

/**
 * Builds a `LibraryLocation` from a `libraries` row and, for S3, the
 * connection it uses, decrypting the S3 secret.
 *
 * The connection is a required argument rather than an optional field so that
 * every caller has to say where it comes from: a query that forgot to join
 * `s3_connections` fails to compile instead of producing a library with no
 * bucket that only fails once a file is asked for.
 *
 * The one place that decryption happens, so every caller reads the same
 * ciphertext the same way rather than five copies of `decryptSecret` drifting
 * apart. Skipping this and handing the encrypted column straight to the S3
 * client is a real failure mode, not a hypothetical one: the credentials
 * "work" right up until a request is actually signed, and then every call
 * fails with SignatureDoesNotMatch.
 */
export function libraryLocationFromRow(
  row: LibraryRow,
  connection: S3ConnectionRow | null,
): LibraryLocation {
  const s3 = row.backend === 's3' ? connection : null
  return {
    id: row.id,
    kind: row.kind,
    backend: row.backend,
    allowWrites: row.allowWrites,
    path: row.path,
    s3Bucket: s3?.bucket ?? null,
    s3Prefix: row.s3Prefix ?? null,
    s3Endpoint: s3?.endpoint ?? null,
    s3Region: s3?.region ?? null,
    s3AccessKeyId: s3?.accessKeyId ?? null,
    s3SecretAccessKey: decryptSecret(s3?.secretAccessKey ?? null),
    s3ForcePathStyle: s3?.forcePathStyle ?? null,
  }
}
