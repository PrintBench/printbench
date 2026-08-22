/**
 * Walks a library into the tree the grouping heuristic consumes.
 *
 * ## Why this does not prune subtrees
 *
 * The obvious optimisation — "if a directory's mtime is unchanged, skip the
 * whole subtree" — is WRONG, and quietly so.
 *
 * A directory's mtime changes when its own entries are added, removed or
 * renamed. It does NOT change when something changes further down. Adding
 * `Dragons/Blue Dragon/new.stl` updates the mtime of `Blue Dragon`, but leaves
 * `Dragons` untouched. Prune on `Dragons` and the new file is never discovered,
 * on this scan or any future one, because the parent stays unchanged forever.
 *
 * So every directory is always visited. What a fast scan actually skips is the
 * expensive part: `stat` on every file. Directory enumeration returns names and
 * types without stat'ing, and one stat of the directory itself tells us whether
 * its contents could have changed. When the fingerprint matches, the files are
 * marked `unchanged` and the scan reuses the metadata it already has.
 *
 * The remaining caveat, which the UI states plainly: a directory's mtime does
 * not change when an existing file's *bytes* change. A fast scan therefore
 * catches new, deleted and renamed files but can miss an in-place edit. The
 * weekly deep scan catches those.
 */

import { isIgnoredName, isSidecarFilename, normalizePath } from './paths'
import { isIndexable } from './media-types'
import type { StorageAdapter } from '../storage/types'
import type { WalkedDir, WalkedFile } from './grouping'

export interface DirFingerprint {
  mtimeMs: number | null
  entryCount: number
}

export interface WalkOptions {
  mode?: 'fast' | 'deep'
  /** Previous fingerprints, keyed by relative directory path. */
  known?: Map<string, DirFingerprint>
  /** Guard against runaway recursion and symlink loops. */
  maxDepth?: number
  /** Abort a scan that is clearly wrong rather than churning for hours. */
  maxEntries?: number
  signal?: AbortSignal
}

export interface WalkStats {
  dirsWalked: number
  /** Directories whose files were not re-stat'ed because nothing changed. */
  dirsUnchanged: number
  filesSeen: number
  filesStatted: number
  /** Directories that could not be read; the scan continues around them. */
  errors: { path: string; reason: string }[]
  truncated: boolean
}

export interface WalkResult {
  tree: WalkedDir
  stats: WalkStats
  /** Fresh fingerprints to persist for the next fast scan. */
  fingerprints: Map<string, DirFingerprint>
  /** Directories whose contents are known to be unchanged since last time. */
  unchangedDirs: Set<string>
}

const DEFAULT_MAX_DEPTH = 24
const DEFAULT_MAX_ENTRIES = 2_000_000

export async function walkLibrary(
  storage: StorageAdapter,
  options: WalkOptions = {},
): Promise<WalkResult> {
  const mode = options.mode ?? 'deep'
  const known = options.known ?? new Map<string, DirFingerprint>()
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES

  const stats: WalkStats = {
    dirsWalked: 0,
    dirsUnchanged: 0,
    filesSeen: 0,
    filesStatted: 0,
    errors: [],
    truncated: false,
  }
  const fingerprints = new Map<string, DirFingerprint>()
  const unchangedDirs = new Set<string>()

  async function walk(relativeDir: string, depth: number): Promise<WalkedDir> {
    const normalized = normalizePath(relativeDir)
    const node: WalkedDir = { path: normalized, files: [], dirs: [] }

    if (depth > maxDepth) {
      stats.errors.push({ path: relativeDir, reason: `Exceeded max depth of ${maxDepth}` })
      return node
    }
    if (stats.filesSeen >= maxEntries) {
      stats.truncated = true
      return node
    }
    options.signal?.throwIfAborted()

    let entries
    try {
      entries = await storage.list(relativeDir)
    } catch (error) {
      stats.errors.push({
        path: relativeDir,
        reason: error instanceof Error ? error.message : String(error),
      })
      return node
    }

    stats.dirsWalked++

    // Fingerprint reflects what the OS sees, not what survived our filtering,
    // so it stays comparable across runs.
    const self = await storage.stat(normalized).catch(() => null)
    const fingerprint: DirFingerprint = {
      mtimeMs: self?.mtimeMs ?? null,
      entryCount: entries.length,
    }
    fingerprints.set(normalized, fingerprint)

    const previous = known.get(normalized)
    const unchanged =
      mode === 'fast' &&
      previous !== undefined &&
      previous.mtimeMs !== null &&
      fingerprint.mtimeMs !== null &&
      previous.mtimeMs === fingerprint.mtimeMs &&
      previous.entryCount === fingerprint.entryCount

    if (unchanged) {
      stats.dirsUnchanged++
      unchangedDirs.add(normalized)
    }

    const visible = entries.filter((entry) => !isIgnoredName(baseName(entry.path)))

    for (const entry of visible) {
      if (entry.isDirectory) continue
      const name = baseName(entry.path)
      /*
       * Sidecars are surfaced but never counted.
       *
       * They are not indexable — `json` is deliberately absent from the media
       * type table, so a library full of unrelated .json files stays out of the
       * index — but grouping has to SEE one to honour it: a folder holding a
       * sidecar is an explicit model root. Filtering them out here is what made
       * that rule dead code for as long as it has existed. They are excluded
       * from the counters because they are still not files we index, and
       * `filesSeen` is reported to the user as such.
       */
      const sidecar = isSidecarFilename(name)
      if (!sidecar && !isIndexable(entry.path)) continue
      if (!sidecar) {
        stats.filesSeen++
        if (!unchanged) stats.filesStatted++
      }
      node.files.push({
        name,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
      } satisfies WalkedFile)
    }

    // Always descend. See the note at the top of this file: a parent's mtime
    // says nothing about its descendants, so pruning here loses files.
    for (const entry of visible) {
      if (!entry.isDirectory) continue
      node.dirs.push(await walk(entry.path, depth + 1))
    }

    return node
  }

  const tree = await walk('', 0)
  return { tree, stats, fingerprints, unchangedDirs }
}

function baseName(p: string): string {
  const normalized = normalizePath(p)
  const slash = normalized.lastIndexOf('/')
  return slash === -1 ? normalized : normalized.slice(slash + 1)
}
