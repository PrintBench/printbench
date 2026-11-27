// @contract scripts/test-map
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildReport,
  findTestFiles,
  parseAnnotations,
  testLevel,
  validateCatalogue,
  type Scenario,
  type TestFile,
} from './lib.js'

const scenario = (overrides: Partial<Scenario> = {}): Scenario => ({
  id: 'SCAN-001',
  title: 'I press Scan and my models appear',
  persona: 'admin',
  tier: 'pr',
  deployments: ['compose'],
  source: 'admin/scanning.md',
  ...overrides,
})

const file = (name: string, overrides: Partial<TestFile> = {}): TestFile => ({
  path: name,
  level: 'unit',
  annotations: { covers: [], bugs: [], contracts: [] },
  ...overrides,
})

const covering = (...covers: string[]) => ({ covers, bugs: [], contracts: [] })

describe('parseAnnotations', () => {
  it('reads line and block comments, with several values each', () => {
    const source = [
      '// @covers SCAN-001, SCAN-002',
      '/**',
      ' * @bug 609569b #60',
      ' */',
      '  /* @contract mesh/stl */',
    ].join('\n')

    expect(parseAnnotations(source)).toEqual({
      covers: ['SCAN-001', 'SCAN-002'],
      bugs: ['609569b', '#60'],
      contracts: ['mesh/stl'],
    })
  })

  it('ignores the same words in code and in prose', () => {
    const source = [
      "const text = '// @covers SCAN-001'",
      '// annotate it with @covers SCAN-002',
    ].join('\n')

    expect(parseAnnotations(source)).toEqual({ covers: [], bugs: [], contracts: [] })
  })
})

describe('testLevel', () => {
  it('grades by how much of the real system the file exercises', () => {
    const integration = "describe('x', { tags: ['integration'] }, () => {})"

    expect(testLevel('scripts/smoke/app.spec.ts', '')).toBe('acceptance')
    expect(testLevel('a.test.ts', integration)).toBe('integration')
    expect(testLevel('a.test.ts', "describe('x', () => {})")).toBe('unit')
    expect(testLevel('a.test.ts', `vi.mock('@pb/db')\n${integration}`)).toBe('mocked')
  })
})

describe('validateCatalogue', () => {
  it('names each problem and drops the broken entry', () => {
    const { scenarios, errors } = validateCatalogue({
      scenarios: [
        scenario(),
        scenario(),
        { ...scenario({ id: 'SCAN-002' }), tier: 'weekly', deployments: [] },
      ],
    })

    expect(scenarios).toHaveLength(1)
    expect(errors).toEqual([
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
    const report = buildReport({ scenarios: [scenario()] }, [
      file('mocked.test.ts', { level: 'mocked', annotations: covering('SCAN-001') }),
      file('db.test.ts', { level: 'integration', annotations: covering('SCAN-001') }),
    ])

    expect(report.scenarios[0]).toMatchObject({
      level: 'integration',
      files: ['db.test.ts', 'mocked.test.ts'],
    })
  })

  it('counts a @bug annotation towards the scenario for that bug', () => {
    const report = buildReport({ scenarios: [scenario({ id: 'BUG-609569b', bug: '609569b' })] }, [
      file('queue.test.ts', { annotations: { covers: [], bugs: ['609569b'], contracts: [] } }),
    ])

    expect(report.scenarios[0]!.level).toBe('unit')
    expect(report.errors).toEqual([])
  })

  it('separates uncovered scenarios from unannotated files', () => {
    const report = buildReport({ scenarios: [scenario()] }, [file('loose.test.ts')])

    expect(report.scenarios[0]!.level).toBe('none')
    expect(report.unannotated).toEqual(['loose.test.ts'])
  })

  it('fails a reference to a scenario or bug that cannot exist', () => {
    const report = buildReport({ scenarios: [scenario()] }, [
      file('typo.test.ts', {
        annotations: { covers: ['SCAN-999'], bugs: ['soon'], contracts: [] },
      }),
    ])

    expect(report.errors).toEqual([
      'typo.test.ts: @covers unknown scenario "SCAN-999"',
      'typo.test.ts: @bug "soon" is not a commit hash or #issue',
    ])
  })
})

describe('the repository', () => {
  let temporary: string | undefined

  afterEach(async () => {
    if (temporary) await rm(temporary, { recursive: true, force: true })
    temporary = undefined
  })

  it('skips the copies of tests that a build leaves behind', async () => {
    temporary = await mkdtemp(path.join(tmpdir(), 'pb-test-map-'))
    for (const directory of ['apps/web', 'apps/web/.next/standalone', 'packages/x/dist']) {
      await mkdir(path.join(temporary, directory), { recursive: true })
      await writeFile(path.join(temporary, directory, 'route.test.ts'), '')
    }

    expect((await findTestFiles(temporary)).map((found) => found.path)).toEqual([
      'apps/web/route.test.ts',
    ])
  })

  it('has a valid catalogue and no annotation pointing at nothing', async () => {
    const root = path.resolve(import.meta.dirname, '../..')
    const catalogue: unknown = JSON.parse(
      await readFile(path.join(root, 'tests/scenarios/catalogue.json'), 'utf8'),
    )

    expect(buildReport(catalogue, await findTestFiles(root)).errors).toEqual([])
  })
})
