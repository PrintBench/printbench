import { normalizeS3Prefix } from '../services/s3-connection-service'

/**
 * Naming and retention for backups written to a bucket.
 *
 * Each instance writes under `<prefix>/<instance id>/`, and only ever lists
 * and prunes its own folder. Two instances sharing a prefix therefore never
 * touch each other's backups.
 *
 * Pruning is the only thing here that deletes, so it is kept narrow: it only
 * ever considers objects whose names this code would have written, directly
 * under the backup prefix, and it only runs after a backup has been written
 * and seen in the listing. Anything else in the prefix — a file someone put
 * there by hand, a backup copied in from elsewhere — is never touched.
 */

export const BACKUP_KEEP_MIN = 1
export const BACKUP_KEEP_MAX = 365
export const BACKUP_KEEP_DEFAULT = 14
export const BACKUP_PREFIX_DEFAULT = 'printbench-backups'

const NAME = /^printbench-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)\.encrypted\.pbbackup$/

/** printbench-2026-11-28T03-30-00Z.encrypted.pbbackup. Sorts by time as text. */
export function backupObjectName(at: Date): string {
  const stamp = at
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/:/g, '-')
  return `printbench-${stamp}.encrypted.pbbackup`
}

/** True for a name backupObjectName could have produced. */
export function isBackupObjectName(name: string): boolean {
  return NAME.test(name)
}

const INSTANCE_FOLDER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * True for a folder an instance writes its backups into: its instance id.
 * Anything else under the prefix is not a backup folder and is ignored.
 */
export function isInstanceFolder(name: string): boolean {
  return INSTANCE_FOLDER.test(name)
}

/**
 * A backup's path under the prefix: `<instance id>/<name>`, or null for
 * anything else. The worker accepts only paths that pass this, so a restore
 * cannot be pointed at any other key in the bucket.
 */
export function parseBackupPath(path: string): { instanceId: string; name: string } | null {
  const [instanceId, name, ...rest] = path.split('/')
  if (rest.length > 0 || !instanceId || !name) return null
  if (!isInstanceFolder(instanceId) || !isBackupObjectName(name)) return null
  return { instanceId, name }
}

/**
 * Which backups to delete, given every name in the prefix.
 *
 * Keeps the newest `keep` of ours. Returns nothing at all unless the backup
 * just written is among the names: if the listing does not show it yet, the
 * write has not been confirmed and this is not the moment to delete older
 * copies.
 */
export function backupsToPrune(names: string[], keep: number, justWritten: string): string[] {
  const ours = [...new Set(names.filter(isBackupObjectName))].sort().reverse()
  if (!ours.includes(justWritten)) return []
  const kept = Math.max(BACKUP_KEEP_MIN, Math.floor(keep))
  return ours.slice(kept).filter((name) => name !== justWritten)
}

/**
 * Whether two prefixes in the same bucket share any keys.
 *
 * Null is the whole bucket and overlaps everything. Compared segment by
 * segment, so "backups" and "backups-old" are apart while "models" and
 * "models/backups" are not.
 */
export function s3PrefixesOverlap(a: string | null, b: string | null): boolean {
  const left = normalizeS3Prefix(a)
  const right = normalizeS3Prefix(b)
  if (left === null || right === null) return true
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}
