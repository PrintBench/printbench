import { createReadStream, type Stats } from 'node:fs'
import { mkdir, opendir, rm, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import { isSafeRelativePath, normalizePath } from '../library/paths'
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

/**
 * Local filesystem storage. Also covers NAS mounts — SMB and NFS are just paths
 * as far as Node is concerned, which is why there is no separate adapter.
 */
export class LocalAdapter implements StorageAdapter {
  readonly library: LibraryLocation
  private readonly root: string
  /** Cached realpath of the root, so symlinked roots resolve consistently. */
  private resolvedRoot: string | undefined

  constructor(library: LibraryLocation) {
    if (library.backend !== 'local') {
      throw new Error(`LocalAdapter given a ${library.backend} library`)
    }
    if (!library.path) {
      throw new Error(`Library ${library.id} has no path`)
    }
    this.library = library
    this.root = path.resolve(library.path)
  }

  private get writable(): boolean {
    return this.library.kind === 'managed' || this.library.allowWrites
  }

  private assertWritable(): void {
    if (!this.writable) throw new ReadOnlyLibraryError(this.library.id)
  }

  private async getResolvedRoot(): Promise<string> {
    if (this.resolvedRoot) return this.resolvedRoot
    try {
      this.resolvedRoot = await realpath(this.root)
    } catch {
      // Root may not exist yet for a managed library; fall back to the literal
      // path so containment can still be reasoned about.
      this.resolvedRoot = this.root
    }
    return this.resolvedRoot
  }

  /**
   * Resolves a library-relative path to an absolute one, refusing anything that
   * escapes the root.
   *
   * Two independent checks, because either alone is insufficient:
   *   - a lexical check catches "..", absolute paths and drive letters;
   *   - a realpath check catches symlinks pointing outside the library, which
   *     no amount of string inspection can detect.
   */
  private async resolve(relativePath: string, mustExist = false): Promise<string> {
    if (!isSafeRelativePath(relativePath)) throw new PathEscapeError(relativePath)

    const root = await this.getResolvedRoot()
    const absolute = path.resolve(root, normalizePath(relativePath))

    if (!isInside(root, absolute)) throw new PathEscapeError(relativePath)

    try {
      const real = await realpath(absolute)
      // A symlink may point anywhere; the resolved target must also be inside.
      if (!isInside(root, real)) throw new PathEscapeError(relativePath)
      return real
    } catch (error) {
      if (error instanceof PathEscapeError) throw error
      if (mustExist) throw error
      // Does not exist yet (a write target). The lexical check already passed.
      return absolute
    }
  }

  async list(relativeDir: string): Promise<StorageEntry[]> {
    const root = await this.getResolvedRoot()
    const absolute =
      relativeDir === '' ? root : await this.resolve(relativeDir, true)

    const entries: StorageEntry[] = []
    let handle
    try {
      handle = await opendir(absolute)
    } catch (error) {
      throw new StorageUnavailableError(describe(error, absolute))
    }

    for await (const item of handle) {
      const childRelative = normalizePath(path.join(relativeDir, item.name))
      try {
        // lstat semantics: a symlink to outside the root must not be followed
        // blindly, so stat the entry and let resolve() vet it on access.
        const info: Stats = await stat(path.join(absolute, item.name))
        entries.push({
          path: childRelative,
          isDirectory: info.isDirectory(),
          size: info.isDirectory() ? 0 : info.size,
          mtimeMs: Math.floor(info.mtimeMs),
        })
      } catch {
        // Vanished or unreadable between readdir and stat. Skip it: a scan must
        // not fail wholesale because one file disappeared mid-walk.
      }
    }

    return entries
  }

  async stat(relativePath: string): Promise<StorageEntry | null> {
    try {
      // The empty path is the library root itself — a legitimate target. It
      // fails the relative-path guard, so resolve it directly; without this the
      // root can never be fingerprinted and a fast scan always re-stats it.
      const absolute =
        normalizePath(relativePath) === ''
          ? await this.getResolvedRoot()
          : await this.resolve(relativePath, true)
      const info = await stat(absolute)
      return {
        path: normalizePath(relativePath),
        isDirectory: info.isDirectory(),
        size: info.isDirectory() ? 0 : info.size,
        mtimeMs: Math.floor(info.mtimeMs),
      }
    } catch (error) {
      if (error instanceof PathEscapeError) throw error
      return null
    }
  }

  async createReadStream(relativePath: string, range?: ByteRange): Promise<Readable> {
    const absolute = await this.resolve(relativePath, true)
    return createReadStream(absolute, range ? { start: range.start, end: range.end } : undefined)
  }

  async write(relativePath: string, data: Readable | Buffer | string): Promise<void> {
    this.assertWritable()
    const absolute = await this.resolve(relativePath)
    await mkdir(path.dirname(absolute), { recursive: true })

    if (data instanceof Readable) {
      await pipeline(data, createWriteStream(absolute))
    } else {
      await writeFile(absolute, data)
    }
  }

  async remove(relativePath: string): Promise<void> {
    this.assertWritable()
    const absolute = await this.resolve(relativePath, true)
    await rm(absolute, { recursive: true, force: true })
  }

  async downloadUrl(relativePath: string): Promise<Delivery> {
    const absolute = await this.resolve(relativePath, true)

    // In production nginx serves the bytes via an internal location, so a
    // multi-gigabyte download never passes through Node. In development there
    // is no proxy, so stream it.
    if (process.env.FILE_DELIVERY === 'xaccel') {
      return {
        kind: 'sendfile',
        absolutePath: absolute,
        relativePath: normalizePath(relativePath),
      }
    }
    return { kind: 'stream' }
  }

  async healthCheck(): Promise<{ ok: boolean; reason?: string; entryCount?: number }> {
    try {
      const root = await this.getResolvedRoot()
      const info = await stat(root)
      if (!info.isDirectory()) return { ok: false, reason: 'Path is not a directory' }

      let entryCount = 0
      const handle = await opendir(root)
      for await (const _entry of handle) {
        entryCount++
        // Only need to know whether it is empty; stop early on a huge library.
        if (entryCount >= 100) break
      }
      return { ok: true, entryCount }
    } catch (error) {
      return { ok: false, reason: describe(error, this.root) }
    }
  }
}

function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true
  const relative = path.relative(root, candidate)
  return (
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  )
}

function describe(error: unknown, target: string): string {
  const code = (error as NodeJS.ErrnoException)?.code
  switch (code) {
    case 'ENOENT':
      return `Path does not exist: ${target}`
    case 'EACCES':
    case 'EPERM':
      return `Permission denied: ${target}`
    case 'ENOTDIR':
      return `Not a directory: ${target}`
    case 'EIO':
      return `I/O error reading ${target} — is the volume still mounted?`
    default:
      return error instanceof Error ? error.message : String(error)
  }
}
