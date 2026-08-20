import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { unzipSync } from 'fflate'
import { isIgnoredPath, isSafeRelativePath, normalizePath } from '@pm/core'

/**
 * Extracting an uploaded zip into a library.
 *
 * Uploading a zip full of models is a different, much more common case than
 * uploading a zip *as* a model file: a Thingiverse or Printables download, or
 * someone's whole existing collection archived into one file. Neither reads
 * as useful sitting in the library as one opaque .zip nobody can browse into,
 * so a zip lands here and is unpacked, never stored whole.
 *
 * The zip-slip guard is the point of this file. Every entry name in a zip is
 * an attacker-controlled string, and "../../../../etc/cron.d/x" is a
 * perfectly legal one — fflate does not check this for you, because fflate
 * has no idea it is about to be written to a filesystem.
 */

/** unzipSync holds the whole archive in memory, so the input itself is capped. */
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
  destination: string
}

/**
 * Extracts `zipPath` into `<libraryRoot>/<destRelativePath>`.
 *
 * Refuses if the destination already exists, rather than merging into it —
 * silently overwriting files nobody asked to overwrite is worse than making
 * someone rename and re-upload.
 */
export async function extractZipIntoLibrary(
  zipPath: string,
  libraryRoot: string,
  destRelativePath: string,
): Promise<ZipIngestResult> {
  const size = (await stat(zipPath)).size
  if (size > MAX_ZIP_INPUT_BYTES) {
    throw new ZipIngestError(
      `That zip is too large to extract (over ${formatBytes(MAX_ZIP_INPUT_BYTES)}).`,
    )
  }

  const root = path.resolve(libraryRoot)
  const destDir = path.resolve(root, destRelativePath)
  if (destDir !== root && !destDir.startsWith(root + path.sep)) {
    throw new ZipIngestError('Refusing to extract outside the library.')
  }
  if (await exists(destDir)) {
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
       * The zip-slip guard. isSafeRelativePath rejects "..", absolute paths
       * and drive letters on the RAW entry name — checking after
       * normalisation would let "../../../etc/passwd" through, because
       * normalizePath only strips leading slashes, not ".." segments.
       */
      if (!isSafeRelativePath(relative)) {
        console.warn(`[zip] skipping unsafe entry: ${name}`)
        continue
      }

      const normalized = normalizePath(relative)
      const target = path.resolve(destDir, normalized)
      // Belt and braces alongside isSafeRelativePath, exactly like a regular
      // upload: this is the last check before a write.
      if (target !== destDir && !target.startsWith(destDir + path.sep)) {
        console.warn(`[zip] skipping entry escaping the destination: ${name}`)
        continue
      }

      bytesExtracted += data.byteLength
      if (bytesExtracted > MAX_ZIP_UNCOMPRESSED_BYTES) {
        throw new ZipIngestError(
          `That zip expands to more than ${formatBytes(MAX_ZIP_UNCOMPRESSED_BYTES)}, which is too large to extract.`,
        )
      }

      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, data)
      written.push(target)
    }
  } catch (error) {
    // Partial extraction is worse than none: a half-written pack looks like a
    // corrupt model to the next scan.
    await rm(destDir, { recursive: true, force: true })
    throw error
  }

  if (written.length === 0) {
    await rm(destDir, { recursive: true, force: true })
    throw new ZipIngestError('Every entry in that zip was rejected as unsafe or ignorable.')
  }

  return { filesExtracted: written.length, bytesExtracted, destination: destDir }
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

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  const exponent = Math.min(Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`
}
