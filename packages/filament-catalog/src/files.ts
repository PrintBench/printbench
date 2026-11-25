import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import {
  CATALOG_ENTITIES,
  type CatalogCounts,
  type CatalogDataset,
  type CatalogEntity,
  type CatalogRows,
  type CatalogSnapshot,
} from './rows'

/*
 * The bundled catalogue on disk: one NDJSON file per entity plus
 * `snapshot.json`.
 *
 * NDJSON rather than a single (or gzipped) JSON document because:
 * - the worker streams it line by line and never holds 15 MB of JSON at once;
 * - text with one record per line delta-compresses in git, so a refresh adds
 *   kilobytes of history rather than a fresh 3.4 MB blob each time;
 * - a refresh PR shows exactly which records changed.
 */

/** The directory this package ships its data in. Resolved from source, as the worker runs via tsx. */
export const BUNDLED_DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url))

export const SNAPSHOT_FILE = 'snapshot.json'

export function entityFile(dataDir: string, entity: CatalogEntity): string {
  return join(dataDir, `${entity.replace('_', '-')}.ndjson`)
}

export async function readSnapshot(dataDir: string = BUNDLED_DATA_DIR): Promise<CatalogSnapshot> {
  return JSON.parse(await readFile(join(dataDir, SNAPSHOT_FILE), 'utf8')) as CatalogSnapshot
}

/** Streams one entity's rows. */
export async function* readRows<E extends CatalogEntity>(
  dataDir: string,
  entity: E,
): AsyncGenerator<CatalogRows[E]> {
  const lines = createInterface({
    input: createReadStream(entityFile(dataDir, entity), 'utf8'),
    crlfDelay: Infinity,
  })
  for await (const line of lines) {
    if (line) yield JSON.parse(line) as CatalogRows[E]
  }
}

/** Streams rows in fixed-size batches, which is how the importer inserts them. */
export async function* readBatches<E extends CatalogEntity>(
  dataDir: string,
  entity: E,
  size: number,
): AsyncGenerator<CatalogRows[E][]> {
  let batch: CatalogRows[E][] = []
  for await (const row of readRows(dataDir, entity)) {
    batch.push(row)
    if (batch.length >= size) {
      yield batch
      batch = []
    }
  }
  if (batch.length) yield batch
}

/** sha256 over the NDJSON files in entity order: the identity of a bundled catalogue. */
export async function contentSha256(dataDir: string): Promise<string> {
  const hash = createHash('sha256')
  for (const entity of CATALOG_ENTITIES) {
    hash.update(`${entity}\n`)
    hash.update(await readFile(entityFile(dataDir, entity)))
  }
  return hash.digest('hex')
}

export type SnapshotSource = Omit<CatalogSnapshot, 'contentSha256' | 'counts'>

/**
 * Writes a normalised dataset and its snapshot. Each file is written to a
 * temporary name and renamed, so an interrupted update leaves the previous
 * file in place rather than a truncated one.
 */
export async function writeDataset(
  dataDir: string,
  dataset: CatalogDataset,
  source: SnapshotSource,
): Promise<CatalogSnapshot> {
  await mkdir(dataDir, { recursive: true })
  const counts = {} as CatalogCounts
  for (const entity of CATALOG_ENTITIES) {
    const rows = dataset[entity]
    counts[entity] = rows.length
    const body = rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '')
    await writeAtomic(entityFile(dataDir, entity), body)
  }
  const snapshot: CatalogSnapshot = {
    ...source,
    contentSha256: await contentSha256(dataDir),
    counts,
  }
  await writeAtomic(join(dataDir, SNAPSHOT_FILE), JSON.stringify(snapshot, null, 2) + '\n')
  return snapshot
}

async function writeAtomic(path: string, body: string): Promise<void> {
  const tmp = `${path}.tmp`
  await writeFile(tmp, body)
  await rename(tmp, path)
}
