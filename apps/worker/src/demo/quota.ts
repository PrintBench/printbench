import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { demoConfig, isDemoMode, managedRoot } from '@pb/core'

/**
 * Upload limits on a public demo.
 *
 * Anyone on the internet can upload there, so the normal 8 GB ceiling would
 * let one visitor fill the disk before midnight. The quota counts bytes on
 * disk under the managed root (plus tus staging) rather than rows in the
 * database, because a file being scanned or extracted is already taking space
 * before any row exists for it.
 */

/** Largest single upload: the demo cap, or the normal limit. */
export function uploadMaxSize(normal: number): number {
  return isDemoMode() ? Math.min(normal, demoConfig().maxUploadBytes) : normal
}

/** Cap on what one zip may expand to. A demo zip can never exceed the whole quota. */
export function zipUncompressedLimit(normal: number): number {
  return isDemoMode() ? Math.min(normal, demoConfig().maxStorageBytes) : normal
}

export class DemoQuotaError extends Error {
  readonly status = 413
  constructor() {
    super('The demo is full for today. It resets at midnight UTC.')
    this.name = 'DemoQuotaError'
  }
}

/** Refuses an upload that would take the demo past its storage quota. */
export async function assertDemoQuota(incomingBytes: number, stagingDir: string): Promise<void> {
  if (!isDemoMode()) return
  const used = (await directoryBytes(managedRoot())) + (await directoryBytes(stagingDir))
  if (used + Math.max(0, incomingBytes) > demoConfig().maxStorageBytes) throw new DemoQuotaError()
}

/** Total size of regular files beneath `dir`; a missing directory is empty. */
export async function directoryBytes(dir: string): Promise<number> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += await directoryBytes(full)
    else if (entry.isFile()) total += (await stat(full).catch(() => ({ size: 0 }))).size
  }
  return total
}
