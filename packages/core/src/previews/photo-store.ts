import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Content-addressed store for uploaded photographs.
 *
 * Deliberately NOT the preview store, although the shape is the same. A
 * generated thumbnail can be thrown away and rendered again; a photograph of
 * the thing someone printed cannot. Keeping them in separate roots means
 * "clear the previews" can never be a data-loss event, and the backup can
 * include one and not the other.
 *
 * Keyed by the digest of the stored bytes, so two uploads of the same picture
 * share one file and a key's content never changes — which is what lets the
 * serving route cache hard.
 */

const PHOTO_KEY = /^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{36}\.webp$/

/** Key for a rendition. `variant` keeps the display image and its thumbnail apart. */
export function photoKey(data: Buffer, variant: 'image' | 'thumb'): string {
  const hash = createHash('sha256').update(data).update(`|${variant}`).digest('hex')
  return `${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash.slice(4, 40)}.webp`
}

export function isPhotoKey(key: string): boolean {
  return PHOTO_KEY.test(key)
}

export class PhotoStore {
  readonly root: string

  constructor(dataDir = process.env.DATA_DIR) {
    this.root = path.join(resolvePhotoDataDir(dataDir), 'photos')
  }

  absolutePath(key: string): string {
    // Keys are generated here, but this path reaches the filesystem and, in
    // production, nginx. Validate anyway.
    if (!isPhotoKey(key)) throw new Error(`Refusing to use a malformed photo key: ${key}`)
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

    // Temporary name then rename, as the preview store does: a half-written
    // image served to a browser is worse than a missing one.
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, data)
    try {
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
    return `/_photos/${key}`
  }
}

let shared: PhotoStore | undefined

export function getPhotoStore(): PhotoStore {
  shared ??= new PhotoStore()
  return shared
}

/**
 * Same resolution rule as the preview store, and for the same reason: web,
 * worker and CLI scripts all start from different directories, so a relative
 * DATA_DIR has to resolve against the repository root or they disagree about
 * where the files are.
 */
function resolvePhotoDataDir(configured: string | undefined): string {
  const value = configured ?? './data'
  if (path.isAbsolute(value)) return value

  // packages/core/src/previews -> repository root
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(path.resolve(here, '../../../..'), value)
}
