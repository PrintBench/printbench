import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/** Validate release inputs before granting a job publication permissions. */
export function prepareRelease({ tag, repository, root = process.cwd() }) {
  const match =
    /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      tag ?? '',
    )
  if (
    !match ||
    match[0] !== tag ||
    match[4]?.split('.').some((part) => /^\d+$/.test(part) && /^0\d/.test(part))
  ) {
    throw new Error(
      'Use a vX.Y.Z tag or a SemVer prerelease such as vX.Y.Z-rc.1. Build metadata is not supported in container tags.',
    )
  }

  const version = tag.slice(1)
  if (version.length > 128) throw new Error('The version exceeds the container tag length limit.')
  const declared = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version
  if (declared !== version) {
    throw new Error(
      `Tag ${tag} does not match package.json version ${declared}. Commit the matching version before tagging.`,
    )
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.exec(repository ?? '')?.[0] !== repository) {
    throw new Error('GITHUB_REPOSITORY must contain an owner/repository name.')
  }

  const notes = `docs/releases/${tag}.md`
  let content
  try {
    content = readFileSync(resolve(root, notes), 'utf8')
  } catch {
    throw new Error(`Add authored release notes at ${notes} before tagging.`)
  }
  const upgradeNotes = content
    .split(/^## Upgrade notes[ \t]*\r?$/m)[1]
    ?.split(/^## /m)[0]
    ?.trim()
  if (!upgradeNotes) {
    throw new Error(
      `${notes} must include a nonempty "## Upgrade notes" section, even when no upgrade action is needed.`,
    )
  }

  const prerelease = Boolean(match[4])
  const image = `ghcr.io/${repository.toLowerCase()}`
  const nginxImage = `${image}-nginx`
  const versions = [version]
  if (!prerelease) {
    versions.push(`${match[1]}.${match[2]}`, match[1], 'latest')
  }
  return {
    version,
    image,
    nginxImage,
    notes,
    prerelease,
    tags: versions.map((value) => `${image}:${value}`),
    nginxTags: versions.map((value) => `${nginxImage}:${value}`),
  }
}

/** Beyond this, a release ships noticeably old filament data. A warning, not a failure. */
export const CATALOG_STALE_DAYS = 30

/**
 * Checks the bundled filament catalogue (packages/filament-catalog/data).
 *
 * The catalogue ships inside the release and is never fetched at runtime, so
 * this is the moment it can be refreshed (`npm run filaments:update`). A
 * missing snapshot fails: the worker would have nothing to import. An old one
 * only warns, so a release can still be cut offline or when upstream is down.
 * Internal consistency is checked by the unit tests, which run in CI.
 */
export function checkFilamentCatalog({ root = process.cwd(), now = new Date() } = {}) {
  let snapshot
  try {
    snapshot = JSON.parse(
      readFileSync(resolve(root, 'packages/filament-catalog/data/snapshot.json'), 'utf8'),
    )
  } catch {
    throw new Error(
      'The filament catalogue snapshot is missing. Run `npm run filaments:update` and commit the result.',
    )
  }
  const generated = new Date(snapshot.generatedAt)
  if (!snapshot.datasetVersion || Number.isNaN(generated.getTime())) {
    throw new Error('packages/filament-catalog/data/snapshot.json is not a valid snapshot.')
  }
  const ageDays = Math.floor((now.getTime() - generated.getTime()) / 86_400_000)
  const warnings =
    ageDays > CATALOG_STALE_DAYS
      ? [
          `The bundled filament catalogue is ${ageDays} days old (dataset ${snapshot.datasetVersion}). ` +
            'Consider `npm run filaments:update` before releasing.',
        ]
      : []
  return { datasetVersion: snapshot.datasetVersion, ageDays, warnings }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const meta = prepareRelease({
      tag: process.argv[2] ?? process.env.GITHUB_REF_NAME,
      repository: process.env.GITHUB_REPOSITORY ?? 'PrintBench/printbench',
    })
    const catalog = checkFilamentCatalog()
    for (const warning of catalog.warnings) {
      process.stderr.write(`Warning: ${warning}\n`)
      // Surfaces on the workflow run summary without failing it.
      if (process.env.GITHUB_ACTIONS) process.stdout.write(`::warning::${warning}\n`)
    }
    const output = [
      `version=${meta.version}`,
      `image=${meta.image}`,
      `nginx_image=${meta.nginxImage}`,
      `notes=${meta.notes}`,
      `prerelease=${meta.prerelease}`,
      `filament_catalog=${catalog.datasetVersion}`,
      'tags<<RELEASE_TAGS',
      ...meta.tags,
      'RELEASE_TAGS',
      'nginx_tags<<RELEASE_NGINX_TAGS',
      ...meta.nginxTags,
      'RELEASE_NGINX_TAGS',
      '',
    ].join('\n')
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output)
    process.stdout.write(output)
  } catch (error) {
    process.stderr.write(`Release preparation failed: ${error.message}\n`)
    process.exitCode = 1
  }
}
