import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Content-addressed store for generated thumbnails.
 *
 * The key encodes everything the image depends on: the file's content digest
 * (or its size and mtime before a digest exists), the requested size, and the
 * renderer version. Change any of those and the key changes, so a stale image
 * can never be served — and bumping RENDERER_VERSION regenerates the lot
 * without a migration.
 *
 * Files are sharded two levels deep. A flat directory of 50,000 thumbnails is
 * slow to list and unpleasant on some filesystems.
 */

export interface PreviewKeyInput {
  fileId: string
  /** sha256 of the file, when known. */
  digest?: string | null
  /** Fallback identity before a digest exists. */
  size?: number | null
  mtimeMs?: number | null
  size_px: number
  rendererVersion: number
  format: 'webp' | 'png'
}

export function previewKey(input: PreviewKeyInput): string {
  const identity = input.digest
    ? `d:${input.digest}`
    : // Before the digest job has run, size and mtime identify the content well
      // enough — and the key changes again once the real digest lands, which
      // simply produces one more render rather than a wrong image.
      `m:${input.fileId}:${input.size ?? 0}:${input.mtimeMs ?? 0}`

  const hash = createHash('sha256')
    .update(`${identity}|${input.size_px}|r${input.rendererVersion}|${input.format}`)
    .digest('hex')

  return `${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash.slice(4, 40)}.${input.format}`
}

export class PreviewStore {
  private readonly root: string

  constructor(dataDir = process.env.DATA_DIR) {
    this.root = path.join(resolveDataDir(dataDir), 'previews')
  }

  absolutePath(key: string): string {
    // Keys are generated, never user input, but validate anyway: this path is
    // handed to the filesystem and, in production, to nginx.
    if (!/^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{36}\.(webp|png)$/.test(key)) {
      throw new Error(`Refusing to use a malformed preview key: ${key}`)
    }
    return path.join(this.root, key)
  }

  async has(key: string): Promise<boolean> {
    try {
      const info = await stat(this.absolutePath(key))
      return info.isFile() && info.size > 0
    } catch {
      return false
    }
  }

  async read(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.absolutePath(key))
    } catch {
      return null
    }
  }

  async write(key: string, data: Buffer): Promise<void> {
    const target = this.absolutePath(key)
    await mkdir(path.dirname(target), { recursive: true })

    /*
     * Write to a temporary name and rename into place. Two workers may render
     * the same file at once, and a half-written thumbnail served to a browser
     * is worse than none — rename is atomic within a filesystem.
     */
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, data)
    try {
      const { rename } = await import('node:fs/promises')
      await rename(temporary, target)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.absolutePath(key), { force: true })
  }

  /** Relative path used for nginx X-Accel-Redirect in production. */
  internalPath(key: string): string {
    return `/_previews/${key}`
  }
}

let shared: PreviewStore | undefined

export function getPreviewStore(): PreviewStore {
  shared ??= new PreviewStore()
  return shared
}

/**
 * Resolves the data directory to one absolute path for every process.
 *
 * A relative DATA_DIR is resolved against the REPOSITORY ROOT, not the current
 * working directory. Three processes run this code — web, worker, and CLI
 * scripts — each started from a different directory, so `./data` otherwise
 * means three different places. That is not hypothetical: the worker wrote
 * thumbnails to apps/worker/data while the web app looked in apps/web/data and
 * served 404s for images that existed.
 *
 * In Docker DATA_DIR is absolute (/data) and this is a no-op.
 */
function resolveDataDir(configured: string | undefined): string {
  const value = configured ?? './data'
  if (path.isAbsolute(value)) return value

  // packages/core/src/previews -> repository root
  const here = path.dirname(fileURLToPath(import.meta.url))
  const repoRoot = path.resolve(here, '../../../..')
  return path.resolve(repoRoot, value)
}
