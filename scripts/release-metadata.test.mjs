import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, URL } from 'node:url'
import { afterEach, test } from 'node:test'
import { checkFilamentCatalog, prepareRelease } from './release-metadata.mjs'

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(
  version = '1.2.3',
  content = '# Release\n\n## Upgrade notes\n\nNo migration is needed.\n',
) {
  const root = mkdtempSync(join(tmpdir(), 'pb-release-'))
  roots.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version }))
  mkdirSync(join(root, 'docs/releases'), { recursive: true })
  writeFileSync(join(root, `docs/releases/v${version}.md`), content)
  // A real checkout always has a bundled filament catalogue; the CLI requires one.
  mkdirSync(join(root, 'packages/filament-catalog/data'), { recursive: true })
  writeFileSync(
    join(root, 'packages/filament-catalog/data/snapshot.json'),
    JSON.stringify({ datasetVersion: '2026.11.23', generatedAt: new Date().toISOString() }),
  )
  return { root, tag: `v${version}`, repository: 'PrintBench/PrintBench' }
}

test('stable releases publish matching tags for both images under a lowercase repository', () => {
  const meta = prepareRelease(fixture())
  assert.equal(meta.prerelease, false)
  assert.equal(meta.notes, 'docs/releases/v1.2.3.md')
  assert.deepEqual(meta.tags, [
    'ghcr.io/printbench/printbench:1.2.3',
    'ghcr.io/printbench/printbench:1.2',
    'ghcr.io/printbench/printbench:1',
    'ghcr.io/printbench/printbench:latest',
  ])
  assert.deepEqual(meta.nginxTags, [
    'ghcr.io/printbench/printbench-nginx:1.2.3',
    'ghcr.io/printbench/printbench-nginx:1.2',
    'ghcr.io/printbench/printbench-nginx:1',
    'ghcr.io/printbench/printbench-nginx:latest',
  ])
})

test('prereleases never publish stable rolling tags', () => {
  for (const version of ['1.2.3-rc.1', '0.7.0-beta', '1.0.0-0']) {
    const meta = prepareRelease(fixture(version))
    assert.equal(meta.prerelease, true)
    assert.deepEqual(meta.tags, [`ghcr.io/printbench/printbench:${version}`])
    assert.deepEqual(meta.nginxTags, [`ghcr.io/printbench/printbench-nginx:${version}`])
  }
})

test('rejects malformed versions and tag injection before reading files', () => {
  for (const tag of [
    'v01.2.3',
    'v1.2',
    'v1.2.3-rc.01',
    'v1.2.3+build',
    'v1.2.3\nlatest',
    'v1.2.3\n',
    '../package.json',
    'v1.2.3-',
  ]) {
    assert.throws(
      () => prepareRelease({ tag, repository: 'PrintBench/printbench' }),
      /Use a vX.Y.Z tag/,
    )
  }
})

test('rejects a version that differs from package.json', () => {
  assert.throws(
    () => prepareRelease({ ...fixture(), tag: 'v1.2.4' }),
    /does not match package.json/,
  )
})

test('requires authored notes and an upgrade section', () => {
  const input = fixture()
  rmSync(join(input.root, 'docs/releases/v1.2.3.md'))
  assert.throws(() => prepareRelease(input), /Add authored release notes/)
  assert.throws(() => prepareRelease(fixture('1.2.3', '')), /Upgrade notes/)
  assert.throws(
    () => prepareRelease(fixture('1.2.3', '## Upgrade notes\n\n## Other\nChanges')),
    /Upgrade notes/,
  )
  assert.throws(() => prepareRelease(fixture('1.2.3', '# Release\nChanges only')), /Upgrade notes/)
})

test('rejects repository names that could inject additional image tags', () => {
  assert.throws(
    () => prepareRelease({ ...fixture(), repository: 'owner/repo\n' }),
    /owner\/repository/,
  )
  assert.throws(
    () => prepareRelease({ ...fixture(), repository: 'owner/repo\nlatest' }),
    /owner\/repository/,
  )
})

test('CLI writes validated multiline GitHub outputs and exits nonzero on failure', () => {
  const input = fixture('1.2.3-rc.1')
  const outputFile = join(input.root, 'output')
  const script = fileURLToPath(new URL('./release-metadata.mjs', import.meta.url))
  const env = { ...process.env, GITHUB_REPOSITORY: input.repository, GITHUB_OUTPUT: outputFile }
  const result = spawnSync(process.execPath, [script, input.tag], {
    cwd: input.root,
    env,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  const output = readFileSync(outputFile, 'utf8')
  assert.match(output, /prerelease=true\n/)
  assert.match(output, /nginx_image=ghcr\.io\/printbench\/printbench-nginx\n/)
  assert.match(
    output,
    /nginx_tags<<RELEASE_NGINX_TAGS\nghcr\.io\/printbench\/printbench-nginx:1\.2\.3-rc\.1\nRELEASE_NGINX_TAGS\n/,
  )
  assert.match(
    output,
    /tags<<RELEASE_TAGS\nghcr.io\/printbench\/printbench:1.2.3-rc.1\nRELEASE_TAGS\n/,
  )
  const invalid = spawnSync(process.execPath, [script, 'v1.2.4'], {
    cwd: input.root,
    env,
    encoding: 'utf8',
  })
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /does not match package.json/)
  assert.equal(readFileSync(outputFile, 'utf8'), output)
})

function catalogFixture(snapshot) {
  const root = mkdtempSync(join(tmpdir(), 'pb-catalog-'))
  roots.push(root)
  if (snapshot) {
    mkdirSync(join(root, 'packages/filament-catalog/data'), { recursive: true })
    writeFileSync(
      join(root, 'packages/filament-catalog/data/snapshot.json'),
      JSON.stringify(snapshot),
    )
  }
  return root
}

test('a recent filament catalogue passes without warnings', () => {
  const root = catalogFixture({ datasetVersion: '2026.11.23', generatedAt: '2026-11-23T02:42:02Z' })
  const result = checkFilamentCatalog({ root, now: new Date('2026-12-01T00:00:00Z') })
  assert.equal(result.datasetVersion, '2026.11.23')
  assert.deepEqual(result.warnings, [])
})

test('an old filament catalogue warns but does not fail', () => {
  const root = catalogFixture({ datasetVersion: '2026.01.01', generatedAt: '2026-01-01T00:00:00Z' })
  const result = checkFilamentCatalog({ root, now: new Date('2026-03-01T00:00:00Z') })
  assert.equal(result.ageDays, 59)
  assert.match(result.warnings[0], /59 days old/)
})

test('a missing or broken filament catalogue snapshot fails', () => {
  assert.throws(() => checkFilamentCatalog({ root: catalogFixture(null) }), /filaments:update/)
  assert.throws(
    () =>
      checkFilamentCatalog({ root: catalogFixture({ datasetVersion: 'x', generatedAt: 'nope' }) }),
    /not a valid snapshot/,
  )
})

test('the committed filament catalogue snapshot is valid', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  assert.ok(checkFilamentCatalog({ root }).datasetVersion)
})
