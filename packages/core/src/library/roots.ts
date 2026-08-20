import { readdir, stat } from 'node:fs/promises'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { isIgnoredName } from './paths'

/**
 * Where libraries are allowed to live, and how to find them by pointing.
 *
 * Nobody should have to know what path their files have *inside a container*
 * to add a library. The server knows what is mounted and what is on it, so it
 * offers that instead of asking. This module is what makes the folder picker
 * possible, and it is the only thing that decides which parts of the
 * filesystem an admin may browse.
 *
 * That last point is why the containment checks here are as careful as the
 * ones in the storage adapter: browsing is an admin-only feature, but "admin"
 * is not the same as "may read every file on the host".
 */

/** Separator for LIBRARY_ROOTS. Windows paths contain colons, so use the platform's. */
const ROOT_SEPARATOR = path.delimiter

export interface DirectoryEntry {
  name: string
  path: string
  /** Rough count of child entries, so an obviously-empty folder is visible. */
  entryCount: number
  /** True when it holds something we would index. */
  looksLikeModels: boolean
}

export interface BrowseResult {
  /** Absolute path being listed. */
  current: string
  /** Parent, or null at a root — the picker must not offer a way out. */
  parent: string | null
  directories: DirectoryEntry[]
  /** Every configured root, for the picker's starting points. */
  roots: string[]
}

export class RootError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RootError'
  }
}

/**
 * The roots an admin may browse.
 *
 * `LIBRARY_ROOTS` is the explicit answer and what the Docker image sets. With
 * nothing configured, fall back to what is almost certainly right: the
 * conventional container mount if it exists, and otherwise the repository, so
 * `npm run dev` on a laptop works without configuration.
 */
export function libraryRoots(): string[] {
  const configured = process.env.LIBRARY_ROOTS?.trim()

  if (configured) {
    return configured
      .split(ROOT_SEPARATOR)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => path.resolve(entry))
  }

  const conventional = '/libraries'
  if (existsSync(conventional)) return [conventional]

  // packages/core/src/library -> repository root
  const here = path.dirname(fileURLToPath(import.meta.url))
  const repoRoot = path.resolve(here, '../../../..')

  /*
   * In development, prefer a folder that plausibly holds models over the
   * repository itself — starting the picker in a tree full of node_modules is
   * technically correct and useless.
   *
   * Non-empty first, because the picker opens the first root and landing in an
   * empty folder makes it look as though nothing was found.
   */
  const likely = ['libraries', 'demo-library']
    .map((name) => path.join(repoRoot, name))
    .filter((candidate) => existsSync(candidate))
    .sort((a, b) => Number(isEmptyDir(a)) - Number(isEmptyDir(b)))

  return likely.length > 0 ? likely : [repoRoot]
}

function isEmptyDir(dir: string): boolean {
  try {
    return readdirSync(dir).length === 0
  } catch {
    return true
  }
}

/**
 * Where a managed library's folder is created.
 *
 * Managed libraries receive uploads, so this has to be writable — which the
 * mounted collection deliberately is not. Keeping them under DATA_DIR means
 * one volume holds everything the application itself owns.
 */
export function managedRoot(): string {
  const configured = process.env.MANAGED_LIBRARY_ROOT?.trim()
  if (configured) return path.resolve(configured)

  const dataDir = process.env.DATA_DIR?.trim() || './data'
  if (path.isAbsolute(dataDir)) return path.join(dataDir, 'libraries')

  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '../../../..', dataDir, 'libraries')
}

/**
 * True when `candidate` is inside one of the roots.
 *
 * Compares real paths, so a symlink pointing out of a root does not slip
 * through. A non-existent candidate is resolved lexically instead — it cannot
 * be a symlink to anywhere if it does not exist.
 */
export function isWithinRoots(candidate: string, roots = libraryRoots()): boolean {
  let resolved: string
  try {
    resolved = realpathSync(candidate)
  } catch {
    resolved = path.resolve(candidate)
  }

  return roots.some((root) => {
    let realRoot: string
    try {
      realRoot = realpathSync(root)
    } catch {
      realRoot = path.resolve(root)
    }

    if (resolved === realRoot) return true
    // The separator matters: /libraries-private must not count as inside
    // /libraries.
    return resolved.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep)
  })
}

/**
 * Lists the folders inside one directory.
 *
 * Files are deliberately omitted: this picks a library root, and a list mixing
 * ten thousand STLs into the choice would be unusable as well as slow.
 */
export async function browseDirectories(target?: string | null): Promise<BrowseResult> {
  const roots = libraryRoots()

  /*
   * No target means "show me the roots". With exactly one root — the normal
   * case in Docker — open it directly rather than making someone click through
   * a list of one.
   */
  const current = target?.trim() ? path.resolve(target.trim()) : (roots[0] ?? path.resolve('.'))

  if (!isWithinRoots(current, roots)) {
    throw new RootError('That folder is outside the places this server may browse.')
  }

  let entries
  try {
    entries = await readdir(current, { withFileTypes: true })
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT') throw new RootError('That folder does not exist.')
    if (code === 'EACCES' || code === 'EPERM') {
      throw new RootError('The server is not allowed to read that folder.')
    }
    throw new RootError('That folder could not be read.')
  }

  const directories: DirectoryEntry[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || isIgnoredName(entry.name)) continue

    const child = path.join(current, entry.name)
    directories.push({
      name: entry.name,
      path: child,
      ...(await describe(child)),
    })
  }

  directories.sort((a, b) => a.name.localeCompare(b.name))

  // At a root the parent is null, so the picker offers no way further up.
  const isRoot = roots.some((root) => path.resolve(root) === current)
  const parent = isRoot ? null : path.dirname(current)

  return {
    current,
    parent: parent && isWithinRoots(parent, roots) ? parent : null,
    directories,
    roots,
  }
}

/** Extensions worth counting as "there are models in here". */
const MODEL_EXTENSIONS = new Set(['stl', '3mf', 'obj', 'ply', 'step', 'stp', 'amf'])

/**
 * A cheap look inside, so the picker can show which folders are worth choosing.
 *
 * Reads one directory level and stops at a small cap: this runs for every
 * folder in a listing, and walking each one properly would make the picker
 * take seconds on a large collection.
 */
async function describe(dir: string): Promise<{ entryCount: number; looksLikeModels: boolean }> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    let looksLikeModels = false

    for (const entry of entries.slice(0, 200)) {
      if (!entry.isFile()) continue
      const extension = entry.name.split('.').pop()?.toLowerCase()
      if (extension && MODEL_EXTENSIONS.has(extension)) {
        looksLikeModels = true
        break
      }
    }

    return { entryCount: entries.length, looksLikeModels }
  } catch {
    // Unreadable subfolders are normal on a NAS; they simply show as empty.
    return { entryCount: 0, looksLikeModels: false }
  }
}

/** Confirms a chosen path is a directory this server may use for a library. */
export async function validateLibraryPath(
  candidate: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const trimmed = candidate.trim()
  if (!trimmed) return { ok: false, error: 'Choose a folder.' }

  const resolved = path.resolve(trimmed)

  if (!isWithinRoots(resolved)) {
    const roots = libraryRoots()
    return {
      ok: false,
      error:
        roots.length === 1
          ? `Libraries must live inside ${roots[0]}.`
          : `Libraries must live inside one of: ${roots.join(', ')}.`,
    }
  }

  const info = await stat(resolved).catch(() => null)
  if (!info) return { ok: false, error: 'That folder does not exist.' }
  if (!info.isDirectory()) return { ok: false, error: 'That is a file, not a folder.' }

  return { ok: true, path: resolved }
}
