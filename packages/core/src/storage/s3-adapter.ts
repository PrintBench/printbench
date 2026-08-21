import type { Readable } from 'node:stream'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import {
  PathEscapeError,
  ReadOnlyLibraryError,
  StorageUnavailableError,
  type ByteRange,
  type Delivery,
  type LibraryLocation,
  type StorageAdapter,
  type StorageEntry,
} from './types'
import { isSafeRelativePath, normalizePath } from '../library/paths'

/**
 * S3-backed libraries. Also covers MinIO, Backblaze B2, Wasabi and anything
 * else speaking the same API.
 *
 * Three things differ from local disk in ways that leak upwards, so they are
 * handled here rather than pretended away:
 *
 * **There are no directories.** A key is a string that happens to contain
 * slashes. `list` uses a delimiter to synthesise them, and an "empty directory"
 * simply does not exist — which is why a scan of an S3 library can never report
 * an empty folder.
 *
 * **There are no mtimes worth trusting for change detection.** LastModified
 * changes whenever an object is rewritten, even identically. The ETag is the
 * better signal and is what the scanner compares.
 *
 * **Downloads never touch this process.** A presigned URL is handed to the
 * browser and the bytes go straight from the bucket, which is the whole reason
 * S3 is worth supporting for large libraries.
 */

/**
 * Multipart tuning.
 *
 * S3 allows at most 10,000 parts, so the part size sets the ceiling on a
 * single object: 8 MiB × 10,000 is 80 GB, comfortably past the 8 GB cap the
 * upload endpoint enforces. Four parts in flight keeps a fast connection busy
 * without letting peak memory (partSize × queueSize) run away.
 */
const MULTIPART_PART_BYTES = 8 * 1024 * 1024
const MULTIPART_CONCURRENCY = 4
export class S3Adapter implements StorageAdapter {
  readonly library: LibraryLocation
  private readonly client: S3Client
  private readonly bucket: string
  private readonly prefix: string

  constructor(library: LibraryLocation) {
    if (library.backend !== 's3') {
      throw new StorageUnavailableError('S3Adapter used for a non-S3 library')
    }
    if (!library.s3Bucket) {
      throw new StorageUnavailableError('The library has no bucket configured')
    }

    this.library = library
    this.bucket = library.s3Bucket

    /*
     * Normalised once, here. A prefix with a leading slash produces keys like
     * "/models/x.stl" — legal in S3 and completely different from
     * "models/x.stl", which is the sort of thing that costs an afternoon.
     */
    this.prefix = (library.s3Prefix ?? '').replace(/^\/+/, '').replace(/\/*$/, '')

    this.client = new S3Client({
      region: library.s3Region ?? 'us-east-1',
      endpoint: library.s3Endpoint ?? undefined,
      /*
       * MinIO and most self-hosted gateways cannot do virtual-host addressing,
       * because that needs a wildcard DNS entry per bucket. Path style is the
       * only thing that works there.
       */
      forcePathStyle: library.s3ForcePathStyle ?? Boolean(library.s3Endpoint),
      credentials:
        library.s3AccessKeyId && library.s3SecretAccessKey
          ? {
              accessKeyId: library.s3AccessKeyId,
              secretAccessKey: library.s3SecretAccessKey,
            }
          : // Absent credentials fall through to the SDK's own chain, which is
            // how an instance role or a mounted credentials file works.
            undefined,
      requestHandler: { requestTimeout: 60_000 },
    })
  }

  /**
   * Library-relative path to a bucket key.
   *
   * The traversal guard runs on the raw input, before any normalisation.
   * Normalising first is the bug that keeps recurring in this codebase: it
   * turns "../../etc/passwd" into something that looks contained.
   */
  private keyFor(relativePath: string): string {
    if (!isSafeRelativePath(relativePath)) throw new PathEscapeError(relativePath)
    const clean = normalizePath(relativePath)
    return this.prefix ? `${this.prefix}/${clean}` : clean
  }

  /** Bucket key back to a library-relative path. */
  private pathFor(key: string): string {
    const withoutPrefix = this.prefix && key.startsWith(`${this.prefix}/`)
      ? key.slice(this.prefix.length + 1)
      : key
    return withoutPrefix.normalize('NFC')
  }

  private assertWritable(): void {
    if (this.library.kind === 'in_place' && !this.library.allowWrites) {
      throw new ReadOnlyLibraryError(this.library.id)
    }
  }

  async list(relativeDir: string): Promise<StorageEntry[]> {
    const base = relativeDir === '' || relativeDir === '.' ? '' : this.keyFor(relativeDir)
    const listPrefix = base === '' ? (this.prefix ? `${this.prefix}/` : '') : `${base}/`

    const entries: StorageEntry[] = []
    let token: string | undefined

    /*
     * Paginated. A bucket returns at most 1000 keys per call and a print
     * library will exceed that in a single folder more often than you would
     * think — a miniatures pack with per-part STLs, for instance.
     */
    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: listPrefix,
          // Synthesises directories: keys sharing a prefix up to the next slash
          // come back as CommonPrefixes instead of individual objects.
          Delimiter: '/',
          ContinuationToken: token,
        }),
      )

      for (const common of response.CommonPrefixes ?? []) {
        if (!common.Prefix) continue
        entries.push({
          path: this.pathFor(common.Prefix.replace(/\/$/, '')),
          isDirectory: true,
          size: 0,
          mtimeMs: 0,
        })
      }

      for (const object of response.Contents ?? []) {
        if (!object.Key || object.Key === listPrefix) continue
        // A zero-byte key ending in "/" is how some tools fake a directory.
        if (object.Key.endsWith('/')) continue

        entries.push({
          path: this.pathFor(object.Key),
          isDirectory: false,
          size: object.Size ?? 0,
          mtimeMs: object.LastModified?.getTime() ?? 0,
          etag: object.ETag?.replace(/"/g, ''),
        })
      }

      token = response.NextContinuationToken
    } while (token)

    return entries
  }

  async stat(relativePath: string): Promise<StorageEntry | null> {
    const key = this.keyFor(relativePath)
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      )
      return {
        path: normalizePath(relativePath),
        isDirectory: false,
        size: response.ContentLength ?? 0,
        mtimeMs: response.LastModified?.getTime() ?? 0,
        etag: response.ETag?.replace(/"/g, ''),
      }
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }

  async createReadStream(relativePath: string, range?: ByteRange): Promise<Readable> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.keyFor(relativePath),
        Range: range ? `bytes=${range.start}-${range.end}` : undefined,
      }),
    )

    if (!response.Body) {
      throw new StorageUnavailableError(`No body returned for ${relativePath}`)
    }
    // In Node the SDK returns a Readable; the union covers browser types too.
    return response.Body as Readable
  }

  async write(relativePath: string, data: Readable | Buffer | string): Promise<void> {
    this.assertWritable()
    const key = this.keyFor(relativePath)

    // Known length already in memory — a sidecar, or a small generated file.
    // One request is cheaper than negotiating a multipart upload for a few
    // hundred bytes.
    if (typeof data === 'string' || Buffer.isBuffer(data)) {
      await this.client.send(
        new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data }),
      )
      return
    }

    /*
     * A stream of unknown length: an uploaded model, which can be gigabytes.
     *
     * PutObject needs the length up front, so this used to buffer the whole
     * thing into memory — fine for a sidecar and fatal for a 6 GB mesh, which
     * is precisely the file someone most wants to upload. `Upload` splits the
     * stream into parts as it arrives, so peak memory is partSize × queueSize
     * (64 MB here) whatever the file's size, and it aborts the multipart
     * upload on failure rather than leaving orphaned parts accruing storage
     * charges in the bucket forever.
     */
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: key, Body: data },
      partSize: MULTIPART_PART_BYTES,
      queueSize: MULTIPART_CONCURRENCY,
      leavePartsOnError: false,
    })

    await upload.done()
  }

  async remove(relativePath: string): Promise<void> {
    this.assertWritable()
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.keyFor(relativePath) }),
    )
  }

  /**
   * A presigned URL, so the bytes never pass through this process.
   *
   * This is the reason S3 is worth supporting for a large library: a
   * multi-gigabyte download becomes a redirect, and Node does no work at all.
   */
  async downloadUrl(relativePath: string, filename?: string): Promise<Delivery> {
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.keyFor(relativePath),
        // Makes the browser save it under the library's name for the file
        // rather than the key's last segment.
        ResponseContentDisposition: filename
          ? `attachment; filename="${filename.replace(/"/g, '')}"`
          : undefined,
      }),
      // Long enough to start a large download, short enough that a copied URL
      // stops working before it can be passed around.
      { expiresIn: 900 },
    )

    return { kind: 'redirect', url }
  }

  /**
   * Confirms the bucket is reachable before a scan runs.
   *
   * The entry count matters as much as reachability: the scanner refuses to
   * proceed when a library it knows to have models suddenly looks empty, and
   * that check needs a number it can trust.
   */
  async healthCheck(): Promise<{ ok: boolean; reason?: string; entryCount?: number }> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }))
    } catch (error) {
      return { ok: false, reason: describeS3Error(error, this.bucket) }
    }

    try {
      // One page is enough: the question is "is there anything here", not
      // "how many things are there".
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.prefix ? `${this.prefix}/` : undefined,
          MaxKeys: 1,
        }),
      )
      return { ok: true, entryCount: response.KeyCount ?? 0 }
    } catch (error) {
      return { ok: false, reason: describeS3Error(error, this.bucket) }
    }
  }

  /** Releases the underlying sockets. */
  destroy(): void {
    this.client.destroy()
  }
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string })?.name
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode
  return name === 'NotFound' || name === 'NoSuchKey' || status === 404
}

/**
 * Turns an SDK error into something an admin can act on.
 *
 * The SDK's own messages name the operation rather than the mistake, and the
 * mistakes here are nearly always the same four.
 */
export function describeS3Error(error: unknown, bucket: string): string {
  const name = (error as { name?: string })?.name ?? ''
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode

  if (name === 'NoSuchBucket' || status === 404) {
    return `The bucket "${bucket}" does not exist, or the endpoint points somewhere else.`
  }
  if (name === 'InvalidAccessKeyId') return 'That access key is not recognised.'
  if (name === 'SignatureDoesNotMatch') return 'The secret key does not match the access key.'
  if (name === 'AccessDenied' || status === 403) {
    return `The credentials are valid but not allowed to read "${bucket}".`
  }
  if (name === 'PermanentRedirect' || name === 'AuthorizationHeaderMalformed') {
    return 'The bucket is in a different region from the one configured.'
  }
  if (name === 'TimeoutError' || name === 'RequestTimeout') {
    return 'The storage endpoint did not respond.'
  }

  const code = (error as { cause?: { code?: string } })?.cause?.code
  if (code === 'ENOTFOUND') return 'Could not resolve the storage endpoint. Check the address.'
  if (code === 'ECONNREFUSED') return 'The storage endpoint refused the connection.'

  return error instanceof Error ? error.message : String(error)
}
