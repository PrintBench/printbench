import { contentSha256, readRows, readSnapshot } from './files'
import { CATALOG_ENTITIES, type CatalogEntity } from './rows'

/*
 * Consistency checks over a bundled catalogue, run by the unit suite against
 * the committed data. The normaliser already refuses bad upstream data; this
 * catches a bad commit instead — a hand-edited line, a half-finished update,
 * files from two different runs.
 */

export interface VerifyResult {
  problems: string[]
  /** Public logo paths the data refers to, for the caller to check exist. */
  logoPaths: string[]
}

export async function verifyDataset(dataDir: string): Promise<VerifyResult> {
  const problems: string[] = []
  const snapshot = await readSnapshot(dataDir)

  const hash = await contentSha256(dataDir)
  if (hash !== snapshot.contentSha256) {
    problems.push(`content sha256 ${hash} does not match snapshot.json ${snapshot.contentSha256}`)
  }

  const keys: Partial<Record<CatalogEntity, Set<string>>> = {}
  const logoPaths: string[] = []
  const need = (entity: CatalogEntity, key: string | null, what: string) => {
    if (key !== null && !keys[entity]?.has(key))
      problems.push(`${what} refers to missing ${entity} ${key}`)
  }

  for (const entity of CATALOG_ENTITIES) {
    const seen = new Set<string>()
    keys[entity] = seen
    let count = 0
    for await (const row of readRows(dataDir, entity)) {
      count++
      const key = 'uuid' in row ? row.uuid : row.ofdId
      if (seen.has(key)) problems.push(`duplicate ${entity} ${key}`)
      seen.add(key)

      switch (entity) {
        case 'brands': {
          const r = row as { logoPath: string | null }
          if (r.logoPath) logoPaths.push(r.logoPath)
          break
        }
        case 'stores': {
          const r = row as { logoPath: string | null }
          if (r.logoPath) logoPaths.push(r.logoPath)
          break
        }
        case 'materials':
          need('brands', (row as { brandUuid: string }).brandUuid, `material ${key}`)
          break
        case 'filaments': {
          const r = row as { brandUuid: string; materialUuid: string }
          need('brands', r.brandUuid, `filament ${key}`)
          need('materials', r.materialUuid, `filament ${key}`)
          break
        }
        case 'variants':
          need('filaments', (row as { filamentUuid: string }).filamentUuid, `variant ${key}`)
          break
        case 'sizes':
          need('variants', (row as { variantUuid: string }).variantUuid, `size ${key}`)
          break
        case 'purchase_links': {
          const r = row as { sizeUuid: string; storeUuid: string }
          need('sizes', r.sizeUuid, `purchase link ${key}`)
          need('stores', r.storeUuid, `purchase link ${key}`)
          break
        }
      }
    }
    if (count !== snapshot.counts[entity]) {
      problems.push(`${entity}: ${count} rows but snapshot.json says ${snapshot.counts[entity]}`)
    }
  }

  // Parent brands can appear in any order, so check them once every brand is known.
  for await (const brand of readRows(dataDir, 'brands')) {
    need('brands', brand.parentBrandUuid, `brand ${brand.uuid} parent`)
  }

  return { problems, logoPaths }
}
