/**
 * Maps the test files onto the scenario catalogue.
 *
 * The catalogue (`tests/scenarios/catalogue.json`) lists what people actually do
 * with PrintBench, plus the bugs they actually hit. Test files say which of
 * those they stand behind with comment annotations:
 *
 *   // @covers SCAN-001 SEARCH-002
 *   // @bug 609569b
 *   // @contract mesh/stl
 *
 * The point is to separate "we have a test near this" from "something drives the
 * real app and would fail if a user could no longer do this", so coverage is
 * graded by how much of the system a test exercises rather than counted.
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export const PERSONAS = ['anyone', 'viewer', 'member', 'admin'] as const
export const TIERS = ['pr', 'nightly'] as const
export const DEPLOYMENTS = ['compose', 'nginx', 'proxy', 'nas', 's3', 'coolify', 'large'] as const

export interface Scenario {
  id: string
  title: string
  persona: (typeof PERSONAS)[number]
  tier: (typeof TIERS)[number]
  deployments: (typeof DEPLOYMENTS)[number][]
  /** A page under printbench-docs/docs, or the commit that added or fixed the behaviour. */
  source: string
  /** Short hash or `#issue`, for scenarios that exist because something broke. */
  bug?: string
}

export interface Annotations {
  covers: string[]
  bugs: string[]
  contracts: string[]
}

/** Strongest first: the order decides which level a scenario is reported at. */
export const LEVELS = ['acceptance', 'integration', 'unit', 'mocked'] as const
export type Level = (typeof LEVELS)[number]

export interface TestFile {
  path: string
  level: Level
  annotations: Annotations
}

export interface Report {
  scenarios: { scenario: Scenario; level: Level | 'none'; files: string[] }[]
  unannotated: string[]
  errors: string[]
}

const ANNOTATION = /^[ \t]*(?:\/\/|\/\*\*?|\*)[ \t]*@(covers|bug|contract)\b([^\n]*)$/gm
const BUG_REFERENCE = /^(?:[0-9a-f]{7,40}|#\d+)$/

export function parseAnnotations(source: string): Annotations {
  const found: Annotations = { covers: [], bugs: [], contracts: [] }
  for (const match of source.matchAll(ANNOTATION)) {
    const values = match[2]!
      .replace(/\*\/.*$/, '')
      .split(/[\s,]+/)
      .filter(Boolean)
    const target =
      match[1] === 'covers' ? found.covers : match[1] === 'bug' ? found.bugs : found.contracts
    target.push(...values)
  }
  return found
}

/**
 * A browser spec drives the running app. Anything that replaces a module is
 * "mocked" even if it also talks to Postgres, because the seam it replaced is
 * exactly where the unnoticed breakage tends to be.
 */
export function testLevel(file: string, source: string): Level {
  if (file.endsWith('.spec.ts')) return 'acceptance'
  if (/^[ \t]*vi\.(?:do)?mock\(/im.test(source)) return 'mocked'
  // Anchored to the describe line so a file that only quotes the tag is not
  // counted as running against Postgres.
  if (/^[ \t]*describe[^\n]*tags:\s*\[\s*['"]integration['"]/m.test(source)) return 'integration'
  return 'unit'
}

export function validateCatalogue(value: unknown): { scenarios: Scenario[]; errors: string[] } {
  const list = (value as { scenarios?: unknown } | null)?.scenarios
  if (!Array.isArray(list)) {
    return { scenarios: [], errors: ['catalogue: expected a "scenarios" array'] }
  }

  const errors: string[] = []
  const scenarios: Scenario[] = []
  const seen = new Set<string>()

  for (const [index, entry] of list.entries()) {
    const item = (entry ?? {}) as Partial<Scenario>
    const name = typeof item.id === 'string' && item.id ? item.id : `entry ${index + 1}`
    const problems: string[] = []

    if (!/^(?:[A-Z][A-Z0-9]*-\d{3}|BUG-(?:[0-9a-f]{7,40}|\d+))$/.test(item.id ?? '')) {
      problems.push('id must look like SCAN-001 or BUG-<commit or issue>')
    }
    if (seen.has(name)) problems.push('duplicate id')
    seen.add(name)
    if (!item.title?.trim()) problems.push('missing title')
    if (!item.source?.trim()) problems.push('missing source')
    if (!PERSONAS.includes(item.persona!)) problems.push(`unknown persona "${item.persona}"`)
    if (!TIERS.includes(item.tier!)) problems.push(`unknown tier "${item.tier}"`)
    if (!Array.isArray(item.deployments) || item.deployments.length === 0) {
      problems.push('needs at least one deployment')
    } else {
      for (const deployment of item.deployments) {
        if (!DEPLOYMENTS.includes(deployment)) problems.push(`unknown deployment "${deployment}"`)
      }
    }
    if (item.bug !== undefined && !BUG_REFERENCE.test(item.bug)) {
      problems.push(`bug "${item.bug}" is not a commit hash or #issue`)
    }

    errors.push(...problems.map((problem) => `catalogue ${name}: ${problem}`))
    if (problems.length === 0) scenarios.push(item as Scenario)
  }

  return { scenarios, errors }
}

export function buildReport(catalogue: unknown, files: TestFile[]): Report {
  const { scenarios, errors } = validateCatalogue(catalogue)
  // An id that failed validation is already reported; naming it again as
  // "unknown" in every file that uses it would bury the actual cause.
  const declared = new Set(
    ((catalogue as { scenarios?: { id?: string }[] } | null)?.scenarios ?? []).map((s) => s?.id),
  )

  for (const file of files) {
    for (const id of file.annotations.covers) {
      if (!declared.has(id)) errors.push(`${file.path}: @covers unknown scenario "${id}"`)
    }
    for (const bug of file.annotations.bugs) {
      if (!BUG_REFERENCE.test(bug)) {
        errors.push(`${file.path}: @bug "${bug}" is not a commit hash or #issue`)
      }
    }
  }

  const rows = scenarios.map((scenario) => {
    const matches = files.filter(
      (file) =>
        file.annotations.covers.includes(scenario.id) ||
        (scenario.bug !== undefined && file.annotations.bugs.includes(scenario.bug)),
    )
    const level: Level | 'none' =
      LEVELS.find((candidate) => matches.some((file) => file.level === candidate)) ?? 'none'
    return { scenario, level, files: matches.map((file) => file.path).sort() }
  })

  const unannotated = files
    .filter(({ annotations: a }) => a.covers.length + a.bugs.length + a.contracts.length === 0)
    .map((file) => file.path)
    .sort()

  return { scenarios: rows, unannotated, errors }
}

const TEST_FILE = /\.(?:test\.(?:ts|tsx|mjs)|spec\.ts)$/
const ROOTS = ['apps', 'packages', 'scripts', 'tests']
// Build output holds copies of real tests, which would be counted twice.
const SKIP = new Set(['node_modules', '.next', 'dist'])

export async function findTestFiles(root: string): Promise<TestFile[]> {
  const found: TestFile[] = []

  async function walk(relative: string) {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      },
    )
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) await walk(child)
      } else if (TEST_FILE.test(entry.name)) {
        const source = await readFile(path.join(root, child), 'utf8')
        found.push({
          path: child,
          level: testLevel(child, source),
          annotations: parseAnnotations(source),
        })
      }
    }
  }

  for (const directory of ROOTS) await walk(directory)
  return found.sort((a, b) => a.path.localeCompare(b.path))
}

export function formatReport(report: Report): string {
  const lines: string[] = []
  const levels = [...LEVELS, 'none'] as const
  const count = (level: Level | 'none', tier?: Scenario['tier']) =>
    report.scenarios.filter((row) => row.level === level && (!tier || row.scenario.tier === tier))
      .length

  lines.push(`Scenarios: ${report.scenarios.length}`, '')
  lines.push('Strongest test behind each scenario      pr  nightly  total')
  for (const level of levels) {
    const cells = [count(level, 'pr'), count(level, 'nightly'), count(level)]
    lines.push(
      `  ${level.padEnd(36)}${String(cells[0]).padStart(5)}${String(cells[1]).padStart(9)}${String(cells[2]).padStart(7)}`,
    )
  }

  const section = (heading: string, items: string[]) => {
    if (items.length === 0) return
    lines.push('', `${heading} (${items.length})`, ...items.map((item) => `  ${item}`))
  }
  const described = (level: Level | 'none') =>
    report.scenarios
      .filter((row) => row.level === level)
      .map(({ scenario }) => `${scenario.id.padEnd(14)}[${scenario.tier}] ${scenario.title}`)

  section('No test at all', described('none'))
  section('Only mocked tests', described('mocked'))
  section('Test files with no annotation', report.unannotated)
  section('Errors', report.errors)

  return lines.join('\n')
}
