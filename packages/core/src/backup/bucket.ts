import type { Readable } from 'node:stream'
import { createStorageAdapter } from '../storage/factory'
import type { LibraryLocation, StorageAdapter } from '../storage/types'
import {
  EnvelopeError,
  HEADER_PROBE_BYTES,
  parseEnvelopeHeader,
  type EnvelopeHeader,
} from './envelope'
import { isBackupObjectName, isInstanceFolder } from './retention'

/**
 * The backups in the bucket, read from the bucket.
 *
 * Not from backup_runs: the point of a list is to show what can be restored,
 * and that includes backups this database has no record of — those written
 * after the backup it was restored from, or by an instance that has since
 * gone. Each one's plaintext header is read for its date, version and key, a
 * few kilobytes per backup.
 *
 * Every instance folder under the prefix is listed, not just this one's:
 * after moving to a new server, the old server's backups are the ones to
 * restore from. Listing is all that happens to another instance's folder.
 */

export interface BucketBackup {
  /** `<instance id>/<name>`, relative to the prefix. What a restore asks for. */
  path: string
  instanceId: string
  name: string
  bytes: number
  modifiedAt: Date
  /** Null when the header could not be read; `problem` says why. */
  header: Pick<EnvelopeHeader, 'createdAt' | 'appVersion' | 'keyId' | 'migration'> | null
  problem: string | null
}

/** Most headers are about 1.5 KB; a larger one costs a second request. */
const FIRST_READ_BYTES = 4096

export async function readBackupHeader(
  storage: StorageAdapter,
  name: string,
): Promise<EnvelopeHeader> {
  let start = await readRange(storage, name, FIRST_READ_BYTES)
  try {
    return parseEnvelopeHeader(start).header
  } catch (error) {
    if (!(error instanceof EnvelopeError) || start.length < FIRST_READ_BYTES) throw error
  }
  start = await readRange(storage, name, HEADER_PROBE_BYTES)
  return parseEnvelopeHeader(start).header
}

/** Newest first. */
export async function listBucketBackups(location: LibraryLocation): Promise<BucketBackup[]> {
  const storage = createStorageAdapter(location)
  try {
    const folders = (await storage.list(''))
      .filter((entry) => entry.isDirectory && isInstanceFolder(entry.path))
      .map((entry) => entry.path)
    const entries = (
      await Promise.all(
        folders.map(async (folder) =>
          (await storage.list(folder))
            .filter((entry) => !entry.isDirectory)
            .map((entry) => ({ ...entry, folder, name: entry.path.slice(folder.length + 1) }))
            .filter((entry) => isBackupObjectName(entry.name)),
        ),
      )
    )
      .flat()
      .sort((a, b) => b.name.localeCompare(a.name))

    return await Promise.all(
      entries.map(async (entry): Promise<BucketBackup> => {
        const base = {
          path: entry.path,
          instanceId: entry.folder,
          name: entry.name,
          bytes: entry.size,
          modifiedAt: new Date(entry.mtimeMs),
        }
        try {
          const header = await readBackupHeader(storage, entry.path)
          return {
            ...base,
            header: {
              createdAt: header.createdAt,
              appVersion: header.appVersion,
              keyId: header.keyId,
              migration: header.migration,
            },
            problem: null,
          }
        } catch (error) {
          return {
            ...base,
            header: null,
            problem: error instanceof EnvelopeError ? error.message : 'Could not be read.',
          }
        }
      }),
    )
  } finally {
    ;(storage as { destroy?: () => void }).destroy?.()
  }
}

async function readRange(storage: StorageAdapter, name: string, bytes: number): Promise<Buffer> {
  const stream: Readable = await storage.createReadStream(name, { start: 0, end: bytes - 1 })
  const chunks: Buffer[] = []
  for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk)
  return Buffer.concat(chunks)
}
