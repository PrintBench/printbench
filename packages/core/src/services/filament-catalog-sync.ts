import { getTableColumns, sql, type SQL } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import { schema, type Database } from '@pb/db'
import {
  BUNDLED_DATA_DIR,
  CATALOG_ENTITIES,
  readBatches,
  readSnapshot,
  type CatalogEntity,
} from '@pb/filament-catalog'

/*
 * Loads the bundled filament catalogue into Postgres.
 *
 * Worker-only, and exported from `@pb/core/filament-catalog-sync` rather than
 * the package index: it reads packages/filament-catalog/data from disk, and
 * the web bundle must never trace 15 MB of NDJSON into its output.
 *
 * The import is keyed on the bundle's content hash, so it is a no-op on every
 * boot except the first after an upgrade (or a restore, which empties these
 * tables). It never deletes a catalogue row: rows missing from the bundle are
 * soft-removed, because owned filament may still point at them.
 */

const BATCH = 500
const LOCK_KEY = 'pb:filament-catalog-sync'

const TABLES = {
  brands: schema.filamentCatalogBrands,
  stores: schema.filamentCatalogStores,
  materials: schema.filamentCatalogMaterials,
  filaments: schema.filamentCatalogFilaments,
  variants: schema.filamentCatalogVariants,
  sizes: schema.filamentCatalogSizes,
} as const satisfies Record<Exclude<CatalogEntity, 'purchase_links'>, PgTable>

/** Columns the import maintains itself rather than copying from the bundle. */
const DERIVED = new Set(['searchText', 'searchVector', 'removedAt', 'seenVersion'])

export interface CatalogSyncResult {
  /** False when the bundle was already imported. */
  imported: boolean
  datasetVersion: string
  contentSha256: string
  counts: Partial<Record<CatalogEntity, number>>
  /** Rows newly soft-removed by this import, per entity. */
  removed: Partial<Record<CatalogEntity, number>>
}

export async function syncFilamentCatalog(
  db: Database,
  options: { dataDir?: string } = {},
): Promise<CatalogSyncResult> {
  const dataDir = options.dataDir ?? BUNDLED_DATA_DIR
  const snapshot = await readSnapshot(dataDir)
  const version = snapshot.contentSha256
  const base = { datasetVersion: snapshot.datasetVersion, contentSha256: version }

  if (await alreadyImported(db, version)) {
    return { ...base, imported: false, counts: {}, removed: {} }
  }

  return db.transaction(async (tx) => {
    // Two workers (or a restore racing a boot) must not interleave imports.
    // Whoever waits re-checks and finds the work done.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${LOCK_KEY}))`)
    if (await alreadyImported(tx, version)) {
      return { ...base, imported: false, counts: {}, removed: {} }
    }

    const counts: CatalogSyncResult['counts'] = {}
    const removed: CatalogSyncResult['removed'] = {}

    for (const entity of CATALOG_ENTITIES) {
      if (entity === 'purchase_links') continue
      const table = TABLES[entity]
      counts[entity] = await upsertEntity(tx, dataDir, entity, table, version)
      const gone = await tx.execute(sql`
        UPDATE ${table} SET removed_at = now()
        WHERE seen_version <> ${version} AND removed_at IS NULL`)
      removed[entity] = gone.rowCount ?? 0
    }

    // Nothing links to a purchase link, so they are simply replaced.
    await tx.delete(schema.filamentCatalogPurchaseLinks)
    let links = 0
    for await (const batch of readBatches(dataDir, 'purchase_links', BATCH)) {
      await tx.insert(schema.filamentCatalogPurchaseLinks).values(batch)
      links += batch.length
    }
    counts.purchase_links = links

    await rebuildSearch(tx, version)

    const meta = {
      datasetVersion: snapshot.datasetVersion,
      sourceTag: snapshot.tag,
      sourceSha256: snapshot.sourceSha256,
      contentSha256: version,
      generatedAt: snapshot.generatedAt,
      counts: snapshot.counts,
      importedAt: new Date(),
    }
    await tx
      .insert(schema.filamentCatalogMeta)
      .values({ id: 'ofd', ...meta })
      .onConflictDoUpdate({ target: schema.filamentCatalogMeta.id, set: meta })

    return { ...base, imported: true, counts, removed }
  })
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]

async function alreadyImported(db: Database | Tx, version: string): Promise<boolean> {
  const [meta] = await db
    .select({ contentSha256: schema.filamentCatalogMeta.contentSha256 })
    .from(schema.filamentCatalogMeta)
  return meta?.contentSha256 === version
}

/**
 * Upserts one entity in batches. Every column the bundle carries is
 * overwritten from `excluded`, and seeing the row again clears `removed_at` —
 * an entry that came back upstream is live again.
 */
async function upsertEntity(
  tx: Tx,
  dataDir: string,
  entity: Exclude<CatalogEntity, 'purchase_links'>,
  table: (typeof TABLES)[typeof entity],
  version: string,
): Promise<number> {
  const columns = getTableColumns(table)
  const set: Record<string, SQL> = { seenVersion: sql`excluded.seen_version`, removedAt: sql`NULL` }
  for (const [key, column] of Object.entries(columns)) {
    if (key === 'uuid' || DERIVED.has(key)) continue
    set[key] = sql.raw(`excluded."${column.name}"`)
  }

  let count = 0
  for await (const batch of readBatches(dataDir, entity, BATCH)) {
    const rows = batch.map((row) => ({ ...row, seenVersion: version, removedAt: null }))
    await tx
      .insert(table)
      .values(rows as never)
      .onConflictDoUpdate({ target: table.uuid, set })
    count += batch.length
  }
  return count
}

/**
 * The variant search text needs its parents' names, so it is built here in one
 * statement rather than per row. Non-alphanumerics become spaces before
 * `to_tsvector` (docs/search-notes.md: punctuation can glue words into one
 * token), and the same text feeds the trigram index for typo tolerance.
 */
async function rebuildSearch(tx: Tx, version: string): Promise<void> {
  await tx.execute(sql`
    UPDATE filament_catalog_variants v
    SET search_text = s.text, search_vector = to_tsvector('pb_search', s.text)
    FROM (
      SELECT v2.uuid,
        trim(regexp_replace(
          concat_ws(' ', b.name, f.name,
            -- Most product names already say the material; repeating it skews ranking.
            CASE WHEN position(lower(f.material) IN lower(f.name)) > 0 THEN NULL ELSE f.material END,
            v2.name),
          '[^[:alnum:]]+', ' ', 'g')) AS text
      FROM filament_catalog_variants v2
      JOIN filament_catalog_filaments f ON f.uuid = v2.filament_uuid
      JOIN filament_catalog_brands b ON b.uuid = f.brand_uuid
      WHERE v2.seen_version = ${version}
    ) s
    WHERE v.uuid = s.uuid AND v.search_text IS DISTINCT FROM s.text`)
  // A vector can be missing even when the text is unchanged (first import).
  await tx.execute(sql`
    UPDATE filament_catalog_variants SET search_vector = to_tsvector('pb_search', search_text)
    WHERE search_vector IS NULL`)
}
