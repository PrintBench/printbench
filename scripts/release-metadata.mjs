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
  const tags = [`${image}:${version}`]
  if (!prerelease) {
    tags.push(`${image}:${match[1]}.${match[2]}`, `${image}:${match[1]}`, `${image}:latest`)
  }
  return { version, image, notes, prerelease, tags }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const meta = prepareRelease({
      tag: process.argv[2] ?? process.env.GITHUB_REF_NAME,
      repository: process.env.GITHUB_REPOSITORY ?? 'PrintBench/printbench',
    })
    const output = [
      `version=${meta.version}`,
      `image=${meta.image}`,
      `notes=${meta.notes}`,
      `prerelease=${meta.prerelease}`,
      'tags<<RELEASE_TAGS',
      ...meta.tags,
      'RELEASE_TAGS',
      '',
    ].join('\n')
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output)
    process.stdout.write(output)
  } catch (error) {
    process.stderr.write(`Release preparation failed: ${error.message}\n`)
    process.exitCode = 1
  }
}
