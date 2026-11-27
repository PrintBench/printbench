/**
 * `npm run test:guard -- --base origin/main`
 *
 * Fails when a change loosens the test rules, removes tests or lowers coverage,
 * unless `--approved` says a person has agreed. CI passes that flag only when
 * the pull request carries the `test-policy` label, and runs the copy of this
 * script that is already on the base branch, so a change is judged by the rules
 * it is trying to alter rather than by its own version of them.
 */
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { weakenings, type Change, type Snapshot } from './guard.js'
import { findTestFiles } from './lib.js'

const args = process.argv.slice(2)
const baseRef = args[args.indexOf('--base') + 1]
if (!args.includes('--base') || !baseRef) {
  console.error('Usage: test:guard -- --base <git ref> [--approved]')
  process.exit(64)
}

const root = process.cwd()
const git = (...command: string[]) =>
  execFileSync('git', command, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const read = (file: string) =>
  readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })

async function snapshot(directory: string): Promise<Snapshot> {
  const catalogue = await read(path.join(directory, 'tests/scenarios/catalogue.json'))
  const manifest = await read(path.join(directory, 'package.json'))
  return {
    catalogue: catalogue ? JSON.parse(catalogue) : { contracts: [], scenarios: [] },
    files: await findTestFiles(directory),
    scripts: manifest ? (JSON.parse(manifest).scripts ?? {}) : {},
  }
}

const temporary = await mkdtemp(path.join(tmpdir(), 'pb-test-guard-'))
try {
  const archive = path.join(temporary, 'base.tar')
  const baseTree = path.join(temporary, 'tree')
  git('archive', '--format=tar', '-o', archive, baseRef)
  execFileSync('mkdir', [baseTree])
  execFileSync('tar', ['-xf', archive, '-C', baseTree])

  // -z keeps awkward paths such as `[publicId]` or spaces intact.
  const fields = git('diff', '--name-status', '-M', '-z', baseRef, '--').split('\0')
  const changes: Change[] = []
  for (let i = 0; i < fields.length - 1;) {
    const status = fields[i++]!
    const first = fields[i++]!
    changes.push(status.startsWith('R') ? { from: first, path: fields[i++]! } : { path: first })
  }
  // Not yet committed, so invisible to `git diff` when run by hand.
  for (const file of git('ls-files', '--others', '--exclude-standard', '-z').split('\0')) {
    if (file) changes.push({ path: file })
  }
  for (const change of changes) {
    if (!change.path.startsWith('.github/workflows/')) continue
    change.before = await read(path.join(baseTree, change.from ?? change.path))
    change.after = await read(path.join(root, change.path))
  }

  const found = weakenings(await snapshot(baseTree), await snapshot(root), changes)

  if (found.length === 0) {
    console.log('Test guard: nothing loosens the test rules.')
  } else {
    console.log(`Test guard: ${found.length} change(s) need a maintainer's agreement\n`)
    console.log(found.map((item) => `  ${item}`).join('\n'))
    if (args.includes('--approved')) {
      console.log('\nApproved.')
    } else {
      console.log(
        '\nSee docs/testing.md. If these are intended, a maintainer adds the "test-policy"\n' +
          'label to the pull request and re-runs the failed job. Agents must not add it.',
      )
      process.exitCode = 1
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
}
