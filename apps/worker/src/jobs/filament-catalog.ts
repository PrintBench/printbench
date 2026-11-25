import { getDb } from '@pb/db'
import { syncFilamentCatalog } from '@pb/core/filament-catalog-sync'

/**
 * Imports the filament catalogue that ships with this release.
 *
 * Fully offline: the data is in the image (packages/filament-catalog/data).
 * Enqueued at every boot, and a no-op unless the bundle changed since the last
 * import — which happens once per upgrade, or after a restore.
 */
export async function handleFilamentCatalogSync(): Promise<void> {
  const started = Date.now()
  const result = await syncFilamentCatalog(getDb())
  if (!result.imported) {
    console.log(`[catalogue] filament catalogue ${result.datasetVersion} already imported`)
    return
  }
  const counts = Object.entries(result.counts)
    .map(([entity, n]) => `${n} ${entity}`)
    .join(', ')
  const removed = Object.entries(result.removed)
    .filter(([, n]) => n > 0)
    .map(([entity, n]) => `${n} ${entity}`)
    .join(', ')
  console.log(
    `[catalogue] imported filament catalogue ${result.datasetVersion} in ${Date.now() - started}ms: ` +
      `${counts}${removed ? `; no longer upstream: ${removed}` : ''}`,
  )
}
