import { readFile, stat } from 'node:fs/promises'
import { unzipSync } from 'fflate'
import { isIgnoredPath, isSafeRelativePath, joinPath, normalizePath, type StorageAdapter } from '@pm/core'

/**
 * Extracting an uploaded zip into a library.
 *
 * Uploading a zip full of models is a different, much more common case than
 * uploading a zip *as* a model file: a Thingiverse or Printables download, or
 * someone's whole existing collection archived into one file. Neither reads
 * as useful sitting in the library as one opaque .zip nobody can browse into,
 * so a zip lands here and is unpacked, never stored whole.
 *
 * Everything is written through the storage adapter rather than `fs`, so this
 * works the same for a local library and an S3 bucket. The adapter is also
 * the second layer of the traversal guard — the first is the explicit check
 * on each entry name below, because every entry name in a zip is an
 * attacker-controlled string and "../../../../etc/cron.d/x" is a perfectly
 * legal one. fflate does not check this for you; it has no idea it is about
 * to be written anywhere.
 */

/** The staged zip is read into memory to be unpacked, so its size is capped. */
export const MAX_ZIP_INPUT_BYTES = 1 * 1024 * 1024 * 1024

/** A second, independent cap on the decompressed total — the actual bomb guard. */
export const MAX_ZIP_UNCOMPRESSED_BYTES = 4 * 1024 * 1024 * 1024

export const MAX_ZIP_ENTRIES = 20_000

export class ZipIngestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipIngestError'
  }
}

export interface ZipIngestResult {
  filesExtracted: number
  bytesExtracted: number
  /** Library-relative folder the contents landed in. */
  destination: string
}

/**
 * Extracts `zipPath` (a local staged upload) into `destRelativePath` within
 * whatever the adapter is backed by.
 *
 * Refuses if the destination already holds anything, rather than merging into
 * it — silently overwriting files nobody asked to overwrite is worse than
 * making someone rename and re-upload.
 */
export async function extractZipIntoLibrary(
  zipPath: string,
  storage: StorageAdapter,
  destRelativePath: string,
): Promise<ZipIngestResult> {
  const size = (await stat(zipPath)).size
  if (size > MAX_ZIP_INPUT_BYTES) {
    throw new ZipIngestError(
      `That zip is too large to extract (over ${formatBytes(MAX_ZIP_INPUT_BYTES)}).`,
    )
  }

  const destination = normalizePath(destRelativePath)
  if (!destination || !isSafeRelativePath(destination)) {
    throw new ZipIngestError('Refusing to extract outside the library.')
  }
  if (await destinationInUse(storage, destination)) {
    throw new ZipIngestError('A folder with that name already exists in the library.')
  }

  const buffer = await readFile(zipPath)
  const entries = unzipSync(buffer)

  const files = Object.entries(entries).filter(([name]) => {
    // A directory entry: fflate represents these as a trailing-slash key with
    // no bytes. A genuine empty file never ends in "/".
    if (name.endsWith('/')) return false
    return !isIgnoredPath(name)
  })

  if (files.length === 0) throw new ZipIngestError('That zip has nothing worth extracting in it.')
  if (files.length > MAX_ZIP_ENTRIES) {
    throw new ZipIngestError(`That zip has too many files (over ${MAX_ZIP_ENTRIES.toLocaleString()}).`)
  }

  /*
   * Most downloaded model packs wrap everything in one top-level folder named
   * after the archive. Without unwrapping it, extracting "Dragon.zip" into a
   * "Dragon" folder produces "Dragon/Dragon/body.stl" — technically correct
   * and useless to look at.
   */
  const stripped = unwrapCommonRoot(files.map(([name]) => name))

  let bytesExtracted = 0
  const written: string[] = []

  try {
    for (const [name, data] of files) {
      const relative = stripped(name)
      if (!relative) continue

      /*
       * The zip-slip guard, on the RAW entry name. Checking after
       * normalisation would let "../../../etc/passwd" through, because
       * normalizePath only strips leading slashes, not ".." segments.
       */
      if (!isSafeRelativePath(relative)) {
        console.warn(`[zip] skipping unsafe entry: ${name}`)
        continue
      }

      const target = joinPath(destination, normalizePath(relative))
      // Belt and braces: the joined path must still sit under the destination.
      // The adapter checks containment against the library root again on write.
      if (target !== destination && !target.startsWith(`${destination}/`)) {
        console.warn(`[zip] skipping entry escaping the destination: ${name}`)
        continue
      }

      bytesExtracted += data.byteLength
      if (bytesExtracted > MAX_ZIP_UNCOMPRESSED_BYTES) {
        throw new ZipIngestError(
          `That zip expands to more than ${formatBytes(MAX_ZIP_UNCOMPRESSED_BYTES)}, which is too large to extract.`,
        )
      }

      await storage.write(target, Buffer.from(data))
      written.push(target)
    }
  } catch (error) {
    /*
     * Roll back what landed. A half-extracted pack looks like a corrupt model
     * to the next scan, and on S3 it would also be silently billable.
     *
     * Removed file by file rather than as a tree: S3 has no directories to
     * remove, and these are exactly the keys this call created. An emptied
     * folder may remain on a local library, which is harmless — the grouping
     * step ignores a directory with no model files, and `destinationInUse`
     * below deliberately tests for *entries* rather than the folder existing,
     * so a retry of the same upload is not blocked by the leftover.
     */
    for (const target of written) {
      await storage.remove(target).catch(() => undefined)
    }
    throw error
  }

  if (written.length === 0) {
    throw new ZipIngestError('Every entry in that zip was rejected as unsafe or ignorable.')
  }

  return { filesExtracted: written.length, bytesExtracted, destination }
}

/**
 * Whether anything already occupies the destination.
 *
 * Tests for entries rather than for the folder existing, because the two
 * differ in ways that matter at both ends: S3 has no folders at all, and on a
 * local library an empty directory left by a rolled-back extraction must not
 * block the retry.
 */
async function destinationInUse(storage: StorageAdapter, destination: string): Promise<boolean> {
  // A file sitting at exactly that path — "Dragon" the file vs "Dragon/" the
  // folder we are about to create.
  const existing = await storage.stat(destination).catch(() => null)
  if (existing && !existing.isDirectory) return true

  const entries = await storage.list(destination).catch(() => [])
  return entries.length > 0
}

/**
 * If every entry shares the same first path segment, strips it. Returns a
 * function rather than a transformed list so the caller can skip an entry
 * (the wrapper directory entry itself, which strips down to "") in the same
 * pass it writes files.
 */
function unwrapCommonRoot(names: string[]): (name: string) => string {
  const firstSegments = new Set(
    names.map((name) => normalizePath(name).split('/')[0]).filter((segment): segment is string => Boolean(segment)),
  )

  if (firstSegments.size !== 1) return (name) => name

  const [root] = firstSegments
  const prefix = `${root}/`
  return (name) => {
    const normalized = normalizePath(name)
    return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized
  }
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  const exponent = Math.min(Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`
}
