/*
 * Refreshes the bundled filament catalogue from an Open Filament Database
 * release.
 *
 *   npm run filaments:update                              # latest release
 *   npm run filaments:update -- --tag dataset-v2026.11.23 # a specific one
 *
 * This is the ONLY place PrintBench talks to OFD. The output is committed and
 * ships in the image, and the worker imports it at boot with no network. See
 * docs/filament-catalog.md for why.
 *
 * Writes:
 *   packages/filament-catalog/data/*.ndjson, snapshot.json, logos.json, LICENSE-OFD
 *   apps/web/public/filament-catalog/{brands,stores}/<uuid>.webp
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { gunzipSync } from 'node:zlib'
import sharp from 'sharp'
import {
  BUNDLED_DATA_DIR,
  CATALOG_ENTITIES,
  normaliseDataset,
  readRows,
  writeDataset,
  type CatalogEntity,
} from '@pb/filament-catalog'

const REPO = 'OpenFilamentCollective/open-filament-database'
const ROOT = new URL('../../', import.meta.url).pathname
const PUBLIC_DIR = join(ROOT, 'apps/web/public/filament-catalog')
const LOGO_INDEX = join(BUNDLED_DATA_DIR, 'logos.json')

/** Logos are shown at card and header size; 256×128 is ample and keeps the image small. */
const LOGO_BOX = { width: 256, height: 128 }

const { values: args } = parseArgs({ options: { tag: { type: 'string' } } })

const headers: Record<string, string> = { 'user-agent': 'printbench-filament-catalog-update' }
if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`

async function get(url: string): Promise<Response> {
  const res = await fetch(url, { headers, redirect: 'follow' })
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`)
  return res
}

const sha256 = (buf: Uint8Array) => createHash('sha256').update(buf).digest('hex')

async function resolveTag(): Promise<string> {
  if (args.tag) return args.tag
  const release = (await (
    await get(`https://api.github.com/repos/${REPO}/releases/latest`)
  ).json()) as {
    tag_name: string
  }
  return release.tag_name
}

async function main() {
  const tag = await resolveTag()
  const asset = (name: string) => `https://github.com/${REPO}/releases/download/${tag}/${name}`
  console.log(`[catalogue] fetching ${REPO} ${tag}`)

  // 1. Dataset, verified against the release's own manifest.
  const manifest = (await (await get(asset('manifest.json'))).json()) as {
    artifacts: { path: string; sha256: string }[]
  }
  const expected = manifest.artifacts.find((a) => a.path === 'json/all.json.gz')?.sha256
  if (!expected) throw new Error('release manifest has no entry for json/all.json.gz')
  const gz = new Uint8Array(await (await get(asset('all.json.gz'))).arrayBuffer())
  const actual = sha256(gz)
  if (actual !== expected)
    throw new Error(`all.json.gz sha256 ${actual} does not match manifest ${expected}`)
  const raw = JSON.parse(gunzipSync(gz).toString('utf8')) as {
    version: string
    generated_at: string
    brands: { uuid: string; slug: string; logo_name?: string | null }[]
    stores: { uuid: string; slug: string; logo_name?: string | null }[]
  }
  console.log(`[catalogue] dataset ${raw.version}, sha256 verified`)

  // 2. Logos, pinned to the same tag.
  const previous = await previousKeys()
  const logoIndex: Record<string, string> = existsSync(LOGO_INDEX)
    ? JSON.parse(await readFile(LOGO_INDEX, 'utf8'))
    : {}
  const brandLogos = await bundleLogos(
    'brands',
    raw.brands,
    (b) => `data/${b.slug}/${b.logo_name}`,
    tag,
    logoIndex,
  )
  const storeLogos = await bundleLogos(
    'stores',
    raw.stores,
    (s) => `stores/${s.slug}/${s.logo_name}`,
    tag,
    logoIndex,
  )

  // 3. Normalise and write.
  const { dataset, dropped } = normaliseDataset(raw, { brandLogos, storeLogos })
  const snapshot = await writeDataset(BUNDLED_DATA_DIR, dataset, {
    source: 'open-filament-database',
    sourceRepo: `https://github.com/${REPO}`,
    licence: 'MIT',
    tag,
    datasetVersion: raw.version,
    generatedAt: raw.generated_at,
    sourceSha256: actual,
  })
  const live = new Set([...brandLogos.keys(), ...storeLogos.keys()])
  const keptIndex = Object.fromEntries(
    Object.entries(logoIndex)
      .filter(([uuid]) => live.has(uuid))
      .sort(),
  )
  await writeFile(LOGO_INDEX, JSON.stringify(keptIndex, null, 2) + '\n')

  // The MIT licence asks that the notice travel with the data.
  const licence = await (
    await get(`https://raw.githubusercontent.com/${REPO}/${tag}/LICENSE`)
  ).text()
  await writeFile(join(BUNDLED_DATA_DIR, 'LICENSE-OFD'), licence)

  // 4. Summary, for the PR description and release notes.
  console.log(`\nFilament catalogue: Open Filament Database ${snapshot.datasetVersion} (${tag})\n`)
  console.log('| entity | rows | added | removed |')
  console.log('| --- | ---: | ---: | ---: |')
  for (const entity of CATALOG_ENTITIES) {
    const now = new Set(dataset[entity].map((r) => ('uuid' in r ? r.uuid : r.ofdId)))
    const before = previous[entity]
    const added = before ? [...now].filter((k) => !before.has(k)).length : now.size
    const removed = before ? [...before].filter((k) => !now.has(k)).length : 0
    console.log(`| ${entity} | ${now.size} | ${added} | ${removed} |`)
  }
  console.log(`\nLogos: ${brandLogos.size} brands, ${storeLogos.size} stores`)
  const drops = Object.entries(dropped)
  if (drops.length) {
    console.log('\nValues dropped by sanity checks:')
    for (const [reason, n] of drops) console.log(`  ${reason}: ${n}`)
  }
}

/** Keys of the currently committed catalogue, to report what an update adds and removes. */
async function previousKeys(): Promise<Partial<Record<CatalogEntity, Set<string>>>> {
  const out: Partial<Record<CatalogEntity, Set<string>>> = {}
  if (!existsSync(join(BUNDLED_DATA_DIR, 'snapshot.json'))) return out
  for (const entity of CATALOG_ENTITIES) {
    const keys = new Set<string>()
    for await (const row of readRows(BUNDLED_DATA_DIR, entity))
      keys.add('uuid' in row ? row.uuid : row.ofdId)
    out[entity] = keys
  }
  return out
}

/**
 * Downloads, rasterises and writes logos as WebP, returning uuid → public path.
 *
 * Everything is re-encoded, SVG included: upstream SVG is untrusted markup and
 * serving it from our origin would be an XSS vector. Re-encoding is skipped
 * when the source file is byte-identical to last time (tracked in logos.json),
 * so a refresh does not churn every logo just because sharp's encoder changed.
 * A logo that fails to download or decode is reported and skipped — a missing
 * logo is cosmetic and must not block a refresh.
 */
async function bundleLogos<T extends { uuid: string; slug: string; logo_name?: string | null }>(
  kind: 'brands' | 'stores',
  records: T[],
  sourcePath: (record: T) => string,
  tag: string,
  index: Record<string, string>,
): Promise<Map<string, string>> {
  const dir = join(PUBLIC_DIR, kind)
  await mkdir(dir, { recursive: true })
  const result = new Map<string, string>()
  const failures: string[] = []
  const queue = records.filter((r) => r.logo_name)

  const worker = async () => {
    for (let record = queue.shift(); record; record = queue.shift()) {
      const out = join(dir, `${record.uuid}.webp`)
      const publicPath = `/filament-catalog/${kind}/${record.uuid}.webp`
      try {
        const src = new Uint8Array(
          await (
            await get(`https://raw.githubusercontent.com/${REPO}/${tag}/${sourcePath(record)}`)
          ).arrayBuffer(),
        )
        const hash = sha256(src)
        if (index[record.uuid] !== hash || !existsSync(out)) {
          const webp = await sharp(src, { density: 300 })
            .resize({ ...LOGO_BOX, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 85 })
            .toBuffer()
          await writeFile(out, webp)
          index[record.uuid] = hash
        }
        result.set(record.uuid, publicPath)
      } catch (err) {
        failures.push(`${record.slug}: ${(err as Error).message}`)
      }
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker))

  // Remove logos for records that no longer exist or no longer have one.
  for (const file of await readdir(dir)) {
    if (!result.has(file.replace(/\.webp$/, ''))) await rm(join(dir, file))
  }
  if (failures.length) {
    console.warn(`[catalogue] ${failures.length} ${kind} logo(s) skipped:`)
    for (const f of failures) console.warn(`  ${f}`)
  }
  return result
}

main().catch((err) => {
  console.error(`[catalogue] update failed: ${(err as Error).message}`)
  process.exit(1)
})
