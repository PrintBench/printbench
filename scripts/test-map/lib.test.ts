// @contract scripts/test-map
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildReport,
  describeTestFile,
  findTestFiles,
  parseAnnotations,
  validateCatalogue,
  type Scenario,
} from './lib.js'
import { NODE_TESTS, runnerFor } from './runners.js'

const root = path.resolve(import.meta.dirname, '../..')

const scenario = (overrides: Partial<Scenario> = {}): Scenario => ({
  id: 'SCAN-001',
  title: 'I press Scan and my models appear',
  persona: 'admin',
  tier: 'pr',
  deployments: ['compose'],
  source: 'admin/scanning.md',
  ...overrides,
})

const catalogue = (scenarios = [scenario()], contracts: string[] = []) => ({ contracts, scenarios })

const PASSING = "it('adds', () => expect(add(1, 2)).toBe(3))"

/** A test file as the report would see it, from its path and real source. */
const file = (name: string, annotation = '// @covers SCAN-001', body = PASSING) =>
  describeTestFile(name, `${annotation}\n${body}\n`)

describe('parseAnnotations', () => {
  it('reads line and block comments, with several values each', () => {
    const header = [
      '// @covers SCAN-001, SCAN-002',
      '/**',
      ' * @bug 609569b #60',
      ' */',
      '  /* @contract mesh/stl */',
    ].join('\n')

    expect(parseAnnotations(header)).toEqual({
      covers: ['SCAN-001', 'SCAN-002'],
      bugs: ['609569b', '#60'],
      contracts: ['mesh/stl'],
    })
  })

  it('only counts comments at the top of the file', () => {
    const quoted = file(
      'packages/x/a.test.ts',
      '// @contract x',
      `const s = \`
// @covers SCAN-001
\`
// @covers SCAN-001
${PASSING}`,
    )

    expect(quoted.annotations.covers).toEqual([])
    expect(
      file('packages/x/a.test.ts', '// annotate it with @covers X').annotations.covers,
    ).toEqual([])
  })
})

describe('describeTestFile', () => {
  const tagged = "describe('x', { tags: ['integration'] }, () => {})"

  it('grades by how much of the real system the file exercises', () => {
    expect(file('scripts/smoke/app.spec.ts').level).toBe('acceptance')
    expect(file('packages/x/a.test.ts', '', tagged).level).toBe('integration')
    expect(file('packages/x/a.test.ts').level).toBe('unit')
    expect(file('packages/x/a.test.ts', '', `vi.mock('@pb/db')\n${tagged}`).level).toBe('mocked')
  })

  it('does not take a tag or a mock quoted in a string for a real one', () => {
    const quoting = file(
      'packages/x/a.test.ts',
      '',
      `const sample = "describe('x', { tags: ['integration'] }); vi.mock('y'); it.skip('z')"
${PASSING}`,
    )

    expect(quoting).toMatchObject({ level: 'unit', mocks: 0, problems: [] })
  })

  it.each([
    ["it.skip('x', () => expect(a).toBe(b))", 'it.skip disables or narrows tests'],
    ["it.only('x', () => expect(a).toBe(b))", 'it.only disables or narrows tests'],
    ["it.todo('x')", 'it.todo disables or narrows tests'],
    ["describe.skip('x', () => {})", 'describe.skip disables or narrows tests'],
    ["test.fixme('x', () => expect(a).toBe(b))", 'test.fixme disables or narrows tests'],
    ["it.skipIf(ci)('x', () => expect(a).toBe(b))", 'it.skipIf disables or narrows tests'],
    ["it.skip.each(rows)('x', () => expect(a).toBe(b))", 'it.skip.each disables or narrows tests'],
    [
      "it('x', { skip: true }, () => expect(a).toBe(b))",
      '{ skip: true } disables or narrows tests',
    ],
    ["xit('x', () => expect(a).toBe(b))", 'xit disables a test'],
    ["it('x', () => { run() })", 'test asserts nothing'],
    ["it('x', () => expect(true).toBe(true))", 'asserts on a literal value'],
    ["it('x', sharedBody)", 'the test body is not inline, so its assertions cannot be seen'],
  ])('rejects %s', (body, message) => {
    expect(file('packages/x/a.test.ts', '', body).problems).toEqual([`line 2: ${message}`])
  })

  it('accepts tables, async assertions and assertion helpers', () => {
    const sound = file(
      'packages/x/a.test.ts',
      '',
      `it.each([1, 2])('%s', (n) => expect(n).toBeGreaterThan(0))
it('rejects', async () => { await expect(run()).rejects.toThrow() })
it('uses a helper', async () => { await expectRefusal(run) })
test.describe('browser', () => { test.beforeEach(() => {}) })`,
    )

    expect(sound).toMatchObject({ tests: 3, problems: [] })
  })
})

describe('runnerFor', () => {
  it('knows which runner, if any, executes a file', () => {
    expect(runnerFor('apps/web/a.test.ts')).toBe('vitest')
    expect(runnerFor('scripts/smoke/app.spec.ts')).toBe('playwright')
    for (const stray of [
      'packages/x/a.spec.ts',
      'packages/x/a.test.tsx',
      'tests/a.test.ts',
      'a.test.ts',
    ]) {
      expect(runnerFor(stray), stray).toBeNull()
    }
  })

  it('lists only node tests that package.json really runs', async () => {
    const { scripts } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))

    for (const name of NODE_TESTS) expect(scripts['test:release']).toContain(name)
  })
})

describe('validateCatalogue', () => {
  it('names each problem and drops the broken entry', () => {
    const { scenarios, errors } = validateCatalogue(
      catalogue(
        [
          scenario(),
          scenario(),
          { ...scenario({ id: 'SCAN-002' }), tier: 'weekly' as never, deployments: [] },
        ],
        ['mesh/stl', 'mesh/stl'],
      ),
    )

    expect(scenarios).toHaveLength(1)
    expect(errors).toEqual([
      'catalogue: duplicate contract "mesh/stl"',
      'catalogue SCAN-001: duplicate id',
      'catalogue SCAN-002: unknown tier "weekly"',
      'catalogue SCAN-002: needs at least one deployment',
    ])
  })

  it('rejects a file that is not a catalogue', () => {
    expect(validateCatalogue([]).errors).toHaveLength(1)
  })
})

describe('buildReport', () => {
  it('reports each scenario at its strongest level', () => {
    const report = buildReport(catalogue(), [
      file('packages/x/mocked.test.ts', '// @covers SCAN-001', `vi.mock('y')\n${PASSING}`),
      file('packages/x/plain.test.ts'),
    ])

    expect(report.scenarios[0]).toMatchObject({
      level: 'unit',
      files: ['packages/x/mocked.test.ts', 'packages/x/plain.test.ts'],
    })
    expect(report.errors).toEqual([])
  })

  it('counts a @bug annotation towards the scenario for that bug', () => {
    const report = buildReport(catalogue([scenario({ id: 'BUG-609569b', bug: '609569b' })]), [
      file('packages/x/queue.test.ts', '// @bug 609569b'),
    ])

    expect(report.scenarios[0]!.level).toBe('unit')
  })

  it('gives no credit to a test that never runs', () => {
    const report = buildReport(catalogue(), [file('packages/x/never.spec.ts')])

    expect(report.scenarios[0]!.level).toBe('none')
    expect(report.errors).toEqual([
      'packages/x/never.spec.ts: no test runner picks this file up, so it never runs',
    ])
  })

  it('fails references to things that do not exist', () => {
    const report = buildReport(catalogue(), [
      file('packages/x/a.test.ts', '// @covers SCAN-999\n// @bug soon\n// @contract invented'),
    ])

    expect(report.errors).toEqual([
      'packages/x/a.test.ts: @covers unknown scenario "SCAN-999"',
      'packages/x/a.test.ts: @bug "soon" is not a commit hash or #issue',
      'packages/x/a.test.ts: @contract "invented" is not listed in the catalogue',
    ])
  })

  it('fails an unannotated file, an empty one and an unused contract', () => {
    const report = buildReport(catalogue([scenario()], ['mesh/stl']), [
      file('packages/x/a.test.ts', ''),
      file('packages/x/empty.test.ts', '// @covers SCAN-001', ''),
    ])

    expect(report.errors).toEqual([
      'packages/x/a.test.ts: no @covers, @bug or @contract annotation at the top',
      'packages/x/empty.test.ts: declares no tests',
      'catalogue: contract "mesh/stl" has no test',
    ])
  })
})

describe('the repository', () => {
  let temporary: string | undefined

  afterEach(async () => {
    if (temporary) await rm(temporary, { recursive: true, force: true })
    temporary = undefined
  })

  it('finds stray tests but not build output or local data', async () => {
    temporary = await mkdtemp(path.join(tmpdir(), 'pb-test-map-'))
    for (const directory of [
      'apps/web/.next/standalone',
      'packages/x/dist',
      'packages/x/data',
      'data/library',
      'e2e',
    ]) {
      await mkdir(path.join(temporary, directory), { recursive: true })
      await writeFile(path.join(temporary, directory, 'route.test.ts'), '')
    }

    expect((await findTestFiles(temporary)).map((found) => found.path)).toEqual([
      'e2e/route.test.ts',
      'packages/x/data/route.test.ts',
    ])
  })

  it('follows its own rules', async () => {
    const real: unknown = JSON.parse(
      await readFile(path.join(root, 'tests/scenarios/catalogue.json'), 'utf8'),
    )

    expect(buildReport(real, await findTestFiles(root)).errors).toEqual([])
  })
})
