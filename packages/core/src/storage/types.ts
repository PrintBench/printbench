/**
 * Storage abstraction.
 *
 * Libraries live on local disk, on a NAS mount (which is just a local path), or
 * in S3. Everything above this interface is unaware of which.
 *
 * This is the ONLY place allowed to touch `fs` or an S3 client. Two guarantees
 * are enforced here and nowhere else:
 *
 *   1. Path containment — a resolved path must stay inside its library root.
 *   2. Read-only in-place libraries — the promise that we never move, rename or
 *      delete the user's own files.
 */

import type { Readable } from 'node:stream'

export interface StorageEntry {
  /** POSIX, NFC-normalised, relative to the library root. */
  path: string
  isDirectory: boolean
  size: number
  mtimeMs: number
  /** S3 ETag, where available. Used for change detection when mtime is not. */
  etag?: string
}

export interface ByteRange {
  start: number
  /** Inclusive, as in HTTP Range. */
  end: number
}

/** How a download should be served, decided by the adapter. */
export type Delivery =
  | { kind: 'redirect'; url: string }
  /** Absolute path for nginx X-Accel-Redirect, plus the library-relative path. */
  | { kind: 'sendfile'; absolutePath: string; relativePath: string }
  | { kind: 'stream' }

export interface LibraryLocation {
  id: string
  kind: 'in_place' | 'managed'
  backend: 'local' | 's3'
  allowWrites: boolean
  /** Local backend. */
  path?: string | null
  /** S3 backend. */
  s3Bucket?: string | null
  s3Prefix?: string | null
  s3Endpoint?: string | null
  s3Region?: string | null
  s3AccessKeyId?: string | null
  s3SecretAccessKey?: string | null
  s3ForcePathStyle?: boolean | null
}

export interface StorageAdapter {
  readonly library: LibraryLocation

  /** Direct children of a directory. Not recursive. */
  list(relativeDir: string): Promise<StorageEntry[]>

  stat(relativePath: string): Promise<StorageEntry | null>

  createReadStream(relativePath: string, range?: ByteRange): Promise<Readable>

  /** Rejects unless the library is writable. */
  write(relativePath: string, data: Readable | Buffer | string): Promise<void>

  /** Rejects unless the library is writable. */
  remove(relativePath: string): Promise<void>

  downloadUrl(relativePath: string, filename?: string): Promise<Delivery>

  /** Root exists and is readable. Checked before every scan. */
  healthCheck(): Promise<{ ok: boolean; reason?: string; entryCount?: number }>
}

/** Thrown when a path escapes its library root. */
export class PathEscapeError extends Error {
  constructor(path: string) {
    super(`Path escapes the library root: ${path}`)
    this.name = 'PathEscapeError'
  }
}

/** Thrown when something tries to write to a read-only library. */
export class ReadOnlyLibraryError extends Error {
  constructor(libraryId: string) {
    super(
      `Library ${libraryId} is read-only. In-place libraries are never modified; ` +
        `enable writes explicitly if that is really intended.`,
    )
    this.name = 'ReadOnlyLibraryError'
  }
}

export class StorageUnavailableError extends Error {
  constructor(reason: string) {
    super(`Library storage unavailable: ${reason}`)
    this.name = 'StorageUnavailableError'
  }
}
