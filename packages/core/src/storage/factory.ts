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
  s3Bucket?: string | null
  s3Prefix?: string | null
  s3Endpoint?: string | null
  s3Region?: string | null
  s3AccessKeyId?: string | null
  s3SecretAccessKey?: string | null
  s3ForcePathStyle?: boolean | null
}

/**
 * Builds a `LibraryLocation` from a `libraries` row, decrypting the S3 secret.
 *
 * The one place that decryption happens, so every caller reads the same
 * ciphertext the same way rather than five copies of `decryptSecret` drifting
 * apart. Skipping this and handing the encrypted column straight to the S3
 * client is a real failure mode, not a hypothetical one: the credentials
 * "work" right up until a request is actually signed, and then every call
 * fails with SignatureDoesNotMatch.
 */
export function libraryLocationFromRow(row: LibraryRow): LibraryLocation {
  return {
    id: row.id,
    kind: row.kind,
    backend: row.backend,
    allowWrites: row.allowWrites,
    path: row.path,
    s3Bucket: row.s3Bucket,
    s3Prefix: row.s3Prefix,
    s3Endpoint: row.s3Endpoint,
    s3Region: row.s3Region,
    s3AccessKeyId: row.s3AccessKeyId,
    s3SecretAccessKey: decryptSecret(row.s3SecretAccessKey ?? null),
    s3ForcePathStyle: row.s3ForcePathStyle,
  }
}
