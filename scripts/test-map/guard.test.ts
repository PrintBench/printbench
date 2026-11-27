// @contract scripts/test-map
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { weakenings, type Snapshot } from './guard.js'
import { describeTestFile } from './lib.js'

const catalogue = {
  contracts: [],
  scenarios: [
    {
      id: 'SCAN-001',
      title: 'I press Scan and my models appear',
      persona: 'admin',
      tier: 'pr',
      deployments: ['compose'],
      source: 'admin/scanning.md',
    },
  ],
}

const ONE = "it('a', () => expect(run()).toBe(1))"
const TWO = `${ONE}\nit('b', () => expect(run()).toBe(2))`

const file = (name: string, body = ONE) => describeTestFile(name, `// @covers SCAN-001\n${body}\n`)

const SCRIPTS = { test: 'vitest run', build: 'b' }

const snapshot = (files: Snapshot['files'], scripts: Snapshot['scripts'] = SCRIPTS): Snapshot => ({
  catalogue,
  files,
  scripts,
})

describe('weakenings', () => {
  const base = snapshot([file('packages/x/a.test.ts', TWO)])

  it('lets a change that only adds tests through', () => {
    const head = snapshot([...base.files, file('packages/x/b.test.ts')], {
      ...base.scripts,
      build: 'different',
    })

    expect(weakenings(base, head, [{ path: 'packages/x/b.test.ts' }])).toEqual([])
  })

  it.each([
    'tests/scenarios/catalogue.json',
    'scripts/test-map/lib.ts',
    'docs/testing.md',
    'AGENTS.md',
    '.claude/settings.json',
    '.github/workflows/ci.yml',
    'vitest.config.ts',
    'playwright.config.ts',
  ])('stops an edit to %s', (path) => {
    expect(weakenings(base, base, [{ path }])).toEqual([`${path}: changes the test rules`])
  })

  it('stops a rule file being moved out of the way', () => {
    expect(weakenings(base, base, [{ from: 'docs/testing.md', path: 'docs/old.md' }])).toEqual([
      'docs/old.md: changes the test rules',
    ])
  })

  it('lets an action version bump through, but not a different action or step', () => {
    const path = '.github/workflows/ci.yml'
    const before = 'steps:\n  - uses: actions/checkout@v7\n  - run: npm test\n'
    const check = (after: string) => weakenings(base, base, [{ path, before, after }])

    expect(check(before.replace('@v7', '@v8'))).toEqual([])
    expect(check(before.replace('actions/checkout', 'someone/checkout'))).toHaveLength(1)
    expect(check(before.replace('npm test', 'true'))).toHaveLength(1)
  })

  it('stops a test script being rewritten or removed', () => {
    const head = snapshot(base.files, { build: 'b' })

    expect(weakenings(base, head, [])).toEqual([
      'package.json: changes or removes the "test" script',
    ])
  })

  it('stops tests disappearing, and the coverage that goes with them', () => {
    expect(weakenings(base, snapshot([file('packages/x/a.test.ts')]), [])).toEqual([
      'packages/x/a.test.ts: 1 fewer test(s) than before',
    ])
    expect(weakenings(base, snapshot([]), [])).toEqual([
      'packages/x/a.test.ts: deleted, taking 2 test(s) with it',
      'SCAN-001: strongest test drops from unit to none',
    ])
  })

  it('follows a renamed test file', () => {
    const head = snapshot([file('packages/x/renamed.test.ts', TWO)])
    const changes = [{ from: 'packages/x/a.test.ts', path: 'packages/x/renamed.test.ts' }]

    expect(weakenings(base, head, changes)).toEqual([])
  })

  it('stops a module being newly mocked', () => {
    const head = snapshot([file('packages/x/a.test.ts', `vi.mock('y')\n${TWO}`)])

    expect(weakenings(base, head, [])).toEqual([
      'packages/x/a.test.ts: replaces more modules with vi.mock (0 before, 1)',
      'SCAN-001: strongest test drops from unit to mocked',
    ])
  })
})

/** The two commands, run as CI and Claude Code run them. */
describe('commands', () => {
  const repository = path.resolve(import.meta.dirname, '../..')
  let work = ''

  const write = async (name: string, content: string) => {
    await mkdir(path.dirname(path.join(work, name)), { recursive: true })
    await writeFile(path.join(work, name), content)
  }
  const run = (script: string, args: string[], input?: string) =>
    spawnSync(
      process.execPath,
      [
        path.join(repository, 'node_modules/tsx/dist/cli.mjs'),
        path.join(repository, 'scripts/test-map', script),
        ...args,
      ],
      { cwd: work, input, encoding: 'utf8' },
    )
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.test',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: work },
    )

  beforeEach(async () => {
    work = await mkdtemp(path.join(tmpdir(), 'pb-guard-test-'))
    await write('package.json', JSON.stringify({ scripts: { test: 'vitest run' } }))
    await write('tests/scenarios/catalogue.json', JSON.stringify(catalogue))
    // A name with brackets and a space, as Next.js routes have.
    await write('apps/web/[id] page/a.test.ts', `// @covers SCAN-001\n${TWO}\n`)
    git('init', '--quiet')
    git('add', '-A')
    git('commit', '--quiet', '-m', 'base')
  })

  afterEach(async () => {
    await rm(work, { recursive: true, force: true })
  })

  it('guard passes an unchanged tree', () => {
    const result = run('guard.mts', ['--base', 'HEAD'])

    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it('guard fails a deleted test until a maintainer approves', async () => {
    await rm(path.join(work, 'apps/web/[id] page/a.test.ts'))

    const refused = run('guard.mts', ['--base', 'HEAD'])
    expect(refused.status).toBe(1)
    expect(refused.stdout).toContain('a.test.ts: deleted, taking 2 test(s) with it')
    expect(run('guard.mts', ['--base', 'HEAD', '--approved']).status).toBe(0)
  })

  it('guard notices a rule file that is not yet committed', async () => {
    await write('docs/testing.md', 'anything goes')

    expect(run('guard.mts', ['--base', 'HEAD']).stdout).toContain('docs/testing.md')
  })

  const hook = (name: string) =>
    run('hook.mts', [], JSON.stringify({ tool_input: { file_path: path.join(work, name) } }))

  it('hook returns a bad test to the agent with exit code 2', async () => {
    await write('packages/x/b.test.ts', "it('b', () => {})\n")

    const result = hook('packages/x/b.test.ts')

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('no @covers, @bug or @contract annotation')
    expect(result.stderr).toContain('test asserts nothing')
  })

  it('hook stays quiet for a sound test and for other files', async () => {
    await write('packages/x/b.test.ts', "it('b', () => {})\n")

    expect(hook('apps/web/[id] page/a.test.ts').status).toBe(0)
    expect(hook('packages/x/source.ts').status).toBe(0)
  })
})
