import type { BucketBackup } from '@pb/core'

/** A backup in a bucket, as the browser sees it: no Dates, nothing secret. */
export interface BucketRow {
  /** `<instance id>/<name>`: what the worker is asked to fetch. */
  path: string
  instanceId: string
  name: string
  bytes: number
  createdAt: string | null
  appVersion: string | null
  keyId: string | null
  problem: string | null
}

export function toBucketRow(backup: BucketBackup): BucketRow {
  return {
    path: backup.path,
    instanceId: backup.instanceId,
    name: backup.name,
    bytes: backup.bytes,
    createdAt: backup.header?.createdAt ?? null,
    appVersion: backup.header?.appVersion ?? null,
    keyId: backup.header?.keyId ?? null,
    problem: backup.problem,
  }
}
