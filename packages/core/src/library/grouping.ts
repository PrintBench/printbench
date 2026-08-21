/**
 * Deciding which directories are "models".
 *
 * This is the highest-risk logic in the application. Get it wrong in one
 * direction and a 400-model library becomes 5,000 junk rows; wrong in the other
 * and a whole Kickstarter drop collapses into a single entry.
 *
 * The shape it has to cope with, drawn from how people actually store prints:
 *
 *   Dragons/                     <- container (a pack), not a model
 *     Red Dragon/                <- model
 *       stl/                     <- common subfolder, belongs to Red Dragon
 *       presupported/            <- ditto
 *       images/                  <- ditto
 *     Blue Dragon/               <- model
 *   loose-benchy.stl             <- model in its own right
 *
 * Pure and synchronous: it takes an already-walked tree so it can be tested
 * exhaustively without touching a filesystem.
 */

import { isModelFile } from './media-types'
import { basename, humanizeName, isIgnoredName, isSidecarFilename, joinPath } from './paths'

/**
 * Folder names that are part of a model rather than a model of their own.
 *
 * If someone genuinely has a model called "stl" this misfires, which is why
 * a nested_model problem is raised and the grouping mode can be changed.
 */
export const COMMON_SUBFOLDERS = new Set([
  '3mf',
  'chitubox',
  'fdm',
  'files',
  'gcode',
  'image',
  'images',
  'img',
  'lychee',
  'lys',
  'parts',
  'photos',
  'pics',
  'presupported',
  'pre-supported',
  'print',
  'prints',
  'resin',
  'sla',
  'source',
  'sources',
  'stl',
  'stls',
  'supported',
  'unsupported',
])

export type GroupingMode = 'deepest' | 'top_level' | 'flat'

/** A directory as produced by the walker. */
export interface WalkedDir {
  /** POSIX, relative to the library root. Empty string is the root itself. */
  path: string
  files: WalkedFile[]
  dirs: WalkedDir[]
}

export interface WalkedFile {
  /** Name only, no directory part. */
  name: string
  size: number
  mtimeMs: number
}

/** A file belonging to a model, with the metadata the scanner needs to store. */
export interface GroupedFile {
  /** Path relative to the library root. */
  path: string
  size: number
  mtimeMs: number
}

export interface GroupedModel {
  /** Directory path, or the file path when isFileModel is true. */
  path: string
  name: string
  isFileModel: boolean
  files: GroupedFile[]
  /** Directories that resolve to models nested inside this one. */
  nestedModelPaths: string[]
}

export interface GroupingResult {
  models: GroupedModel[]
  /** Container directories: packs or creator folders holding several models. */
  containers: string[]
}

export interface GroupingOptions {
  mode?: GroupingMode
  /** For `flat`: directories at exactly this depth become models. */
  depth?: number
}

function isCommonSubfolder(path: string): boolean {
  return COMMON_SUBFOLDERS.has(basename(path).toLowerCase())
}

/** Files in this directory, and in any common subfolders beneath it. */
function collectOwnFiles(dir: WalkedDir): GroupedFile[] {
  const collected: GroupedFile[] = []

  for (const file of dir.files) {
    if (isIgnoredName(file.name)) continue
    if (isSidecarFilename(file.name)) continue
    // Size and mtime travel with the path: the scanner stores them, and the
    // digest step later uses them to decide what actually needs re-hashing.
    collected.push({ path: joinPath(dir.path, file.name), size: file.size, mtimeMs: file.mtimeMs })
  }

  for (const child of dir.dirs) {
    if (isIgnoredName(basename(child.path))) continue
    if (isCommonSubfolder(child.path)) {
      // A common subfolder contributes its files, recursively: people nest
      // "stl/presupported/" and both levels belong to the same model.
      collected.push(...collectOwnFiles(child))
    }
  }

  return collected
}

function hasSidecar(dir: WalkedDir): boolean {
  // Any sidecar name, current or legacy: a folder marked as a model root by
  // the old name must keep grouping the same way after the rename.
  return dir.files.some((file) => isSidecarFilename(file.name))
}

/** Does this directory hold model files of its own (including common subfolders)? */
function hasDirectModelFiles(dir: WalkedDir): boolean {
  return collectOwnFiles(dir).some((file) => isModelFile(file.path))
}

/** Non-common, non-ignored subdirectories — candidate models in their own right. */
function realSubdirs(dir: WalkedDir): WalkedDir[] {
  return dir.dirs.filter(
    (child) => !isIgnoredName(basename(child.path)) && !isCommonSubfolder(child.path),
  )
}

/** True when the subtree contains a model file anywhere. */
function subtreeHasModelFiles(dir: WalkedDir): boolean {
  if (hasDirectModelFiles(dir)) return true
  return realSubdirs(dir).some((child) => subtreeHasModelFiles(child))
}

export function groupModels(root: WalkedDir, options: GroupingOptions = {}): GroupingResult {
  const mode = options.mode ?? 'deepest'
  const models: GroupedModel[] = []
  const containers: string[] = []

  function emitModel(dir: WalkedDir, nested: string[] = []): void {
    const files = collectOwnFiles(dir)
    if (files.length === 0) return
    models.push({
      path: dir.path,
      name: humanizeDirName(dir.path),
      isFileModel: false,
      files,
      nestedModelPaths: nested,
    })
  }

  /** Everything below, treated as one model. Used by `top_level`. */
  function emitSubtreeAsModel(dir: WalkedDir): void {
    const files: GroupedFile[] = []
    const visit = (node: WalkedDir) => {
      files.push(...collectOwnFiles(node))
      for (const child of realSubdirs(node)) visit(child)
    }
    visit(dir)
    if (files.length === 0) return
    models.push({
      path: dir.path,
      name: humanizeDirName(dir.path),
      isFileModel: false,
      files,
      nestedModelPaths: [],
    })
  }

  function visit(dir: WalkedDir, depth: number): void {
    // 1. A sidecar is an explicit declaration; it always wins.
    if (hasSidecar(dir) && dir.path !== '') {
      emitModel(dir)
      return
    }

    const children = realSubdirs(dir).filter((child) => subtreeHasModelFiles(child))
    const ownModelFiles = hasDirectModelFiles(dir)

    // 2. `flat`: only directories at exactly the configured depth are models.
    if (mode === 'flat') {
      const target = options.depth ?? 1
      if (depth === target && dir.path !== '') {
        emitSubtreeAsModel(dir)
        return
      }
      if (depth < target) {
        if (dir.path !== '') containers.push(dir.path)
        for (const child of children) visit(child, depth + 1)
        emitLooseFiles(dir)
      }
      return
    }

    // 3. Leaf case: files of its own and no model subdirectories.
    if (ownModelFiles && children.length === 0) {
      if (dir.path === '') {
        emitLooseFiles(dir)
      } else {
        emitModel(dir)
      }
      return
    }

    // 4. Container: no files of its own, but models beneath it.
    if (!ownModelFiles && children.length > 0) {
      if (dir.path !== '') containers.push(dir.path)
      for (const child of children) visit(child, depth + 1)
      return
    }

    // 5. Ambiguous: files of its own AND model subdirectories.
    if (ownModelFiles && children.length > 0) {
      if (mode === 'top_level' && dir.path !== '') {
        emitSubtreeAsModel(dir)
        return
      }
      // `deepest`: each child is its own model, and this directory's own files
      // become a model too. Nested paths are recorded so the UI can offer a
      // merge, and a nested_model problem is raised against them.
      const nested = children.map((child) => child.path)
      if (dir.path === '') {
        emitLooseFiles(dir)
      } else {
        emitModel(dir, nested)
      }
      for (const child of children) visit(child, depth + 1)
      return
    }

    // 6. Nothing here: recurse in case of empty intermediate directories.
    if (dir.path !== '' && (children.length > 0 || dir.files.length > 0)) {
      containers.push(dir.path)
    }
    for (const child of children) visit(child, depth + 1)
    emitLooseFiles(dir)
  }

  /**
   * Model files sitting directly in a container or at the library root become
   * one model each. Simpler than inventing a folder for them, and the user can
   * organise later.
   */
  function emitLooseFiles(dir: WalkedDir): void {
    for (const file of dir.files) {
      if (isIgnoredName(file.name)) continue
      const path = joinPath(dir.path, file.name)
      if (!isModelFile(path)) continue
      models.push({
        path,
        name: humanizeDirName(path),
        isFileModel: true,
        files: [{ path, size: file.size, mtimeMs: file.mtimeMs }],
        nestedModelPaths: [],
      })
    }
  }

  visit(root, 0)
  return { models, containers }
}

function humanizeDirName(path: string): string {
  return humanizeName(basename(path))
}

/**
 * Filename keywords marking a mesh that already has print supports.
 *
 * Matched against the filename and every ancestor directory, since the
 * convention is usually a "presupported/" folder rather than a suffix.
 */
const SUPPORT_PATTERN =
  /(^|[_\-. /])(presupported|pre-supported|presup|supported|sup|wsupports|w[_\-. ]?supports)([_\-. /]|$)/i

export function looksPresupported(relativePath: string): boolean {
  return SUPPORT_PATTERN.test(relativePath)
}

/**
 * Chooses a model's preview file.
 *
 * Order: an image named like the model or like a cover, then any other image,
 * then the largest previewable mesh, then anything renderable at all. Images
 * win because a creator-supplied render is almost always better than ours.
 */
export function pickPreviewFile(
  files: { path: string; size: number; category: string; previewable: boolean }[],
  modelName: string,
): string | undefined {
  const images = files.filter((file) => file.category === 'image')
  const slug = modelName.toLowerCase().replace(/[^a-z0-9]/g, '')

  const preferred = images.find((file) => {
    const stem = basename(file.path).toLowerCase().replace(/\.[^.]+$/, '')
    const normalized = stem.replace(/[^a-z0-9]/g, '')
    return (
      /^(preview|cover|thumb|thumbnail|render|main)/.test(stem) ||
      (slug.length > 0 && normalized === slug)
    )
  })
  if (preferred) return preferred.path

  const inImagesFolder = images.find((file) => /(^|\/)(images?|img|pics|photos)\//i.test(file.path))
  if (inImagesFolder) return inImagesFolder.path

  if (images.length > 0) return images[0]!.path

  const meshes = files.filter((file) => file.previewable).sort((a, b) => b.size - a.size)
  return meshes[0]?.path
}
