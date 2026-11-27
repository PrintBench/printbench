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
import { analyze } from './analyze.js'
import { runnerFor, type Runner } from './runners.js'

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
  /** `null` when nothing executes the file, so it can stand behind nothing. */
  runner: Runner | null
  level: Level
  annotations: Annotations
  tests: number
  mocks: number
  problems: string[]
}

export interface Report {
  scenarios: { scenario: Scenario; level: Level | 'none'; files: string[] }[]
  errors: string[]
}

const ANNOTATION = /^[ \t]*(?:\/\/|\/\*\*?|\*)[ \t]*@(covers|bug|contract)\b([^\n]*)$/gm
const BUG_REFERENCE = /^(?:[0-9a-f]{7,40}|#\d+)$/

/** Takes the comments at the top of a file, not the whole source. */
export function parseAnnotations(header: string): Annotations {
  const found: Annotations = { covers: [], bugs: [], contracts: [] }
  for (const match of header.matchAll(ANNOTATION)) {
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
export function describeTestFile(file: string, source: string): TestFile {
  const { header, tests, mocks, integration, problems } = analyze(file, source)
  const runner = runnerFor(file)
  const level: Level =
    runner === 'playwright'
      ? 'acceptance'
      : mocks > 0
        ? 'mocked'
        : integration
          ? 'integration'
          : 'unit'
  return {
    path: file,
    runner,
    level,
    annotations: parseAnnotations(header),
    tests,
    mocks,
    problems,
  }
}

export function validateCatalogue(value: unknown): {
  scenarios: Scenario[]
  contracts: string[]
  errors: string[]
} {
  const { scenarios: list, contracts: listed } = (value ?? {}) as {
    scenarios?: unknown
    contracts?: unknown
  }
  if (!Array.isArray(list)) {
    return { scenarios: [], contracts: [], errors: ['catalogue: expected a "scenarios" array'] }
  }

  // A missing contract list is reported but does not hide the scenarios, so the
  // guard can still compare against a catalogue written before contracts existed.
  const errors: string[] = []
  if (!Array.isArray(listed)) errors.push('catalogue: expected a "contracts" array')
  const contracts: string[] = []
  for (const contract of Array.isArray(listed) ? listed : []) {
    if (typeof contract !== 'string' || !contract.trim()) {
      errors.push('catalogue: every contract must be a non-empty name')
    } else if (contracts.includes(contract)) {
      errors.push(`catalogue: duplicate contract "${contract}"`)
    } else {
      contracts.push(contract)
    }
  }
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

  return { scenarios, contracts, errors }
}

export function buildReport(catalogue: unknown, files: TestFile[]): Report {
  const { scenarios, contracts, errors } = validateCatalogue(catalogue)
  // An id that failed validation is already reported; naming it again as
  // "unknown" in every file that uses it would bury the actual cause.
  const declared = new Set(
    ((catalogue as { scenarios?: { id?: string }[] } | null)?.scenarios ?? []).map((s) => s?.id),
  )
  const used = new Set<string>()

  for (const file of files) {
    const fail = (message: string) => errors.push(`${file.path}: ${message}`)
    const { covers, bugs, contracts: claimed } = file.annotations

    if (!file.runner) fail('no test runner picks this file up, so it never runs')
    if (covers.length + bugs.length + claimed.length === 0) {
      fail('no @covers, @bug or @contract annotation at the top')
    }
    for (const id of covers) {
      if (!declared.has(id)) fail(`@covers unknown scenario "${id}"`)
    }
    for (const bug of bugs) {
      if (!BUG_REFERENCE.test(bug)) fail(`@bug "${bug}" is not a commit hash or #issue`)
    }
    for (const contract of claimed) {
      used.add(contract)
      if (!contracts.includes(contract)) {
        fail(`@contract "${contract}" is not listed in the catalogue`)
      }
    }
    if (file.tests === 0) fail('declares no tests')
    for (const problem of file.problems) fail(problem)
  }

  // A name with no test behind it could be claimed later without anyone seeing
  // the catalogue change.
  for (const contract of contracts) {
    if (!used.has(contract)) errors.push(`catalogue: contract "${contract}" has no test`)
  }

  const rows = scenarios.map((scenario) => {
    const matches = files.filter(
      (file) =>
        file.runner !== null &&
        (file.annotations.covers.includes(scenario.id) ||
          (scenario.bug !== undefined && file.annotations.bugs.includes(scenario.bug))),
    )
    const level: Level | 'none' =
      LEVELS.find((candidate) => matches.some((file) => file.level === candidate)) ?? 'none'
    return { scenario, level, files: matches.map((file) => file.path).sort() }
  })

  return { scenarios: rows, errors }
}

// Broader than what runs, so that a test put somewhere nothing looks is found.
export const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/
// Build output holds copies of real tests, which would be counted twice.
const SKIP_ANYWHERE = new Set(['node_modules', '.next', 'dist', '.git'])
// Local data, scratch checkouts and AGPL reference material at the top level.
const SKIP_AT_ROOT = new Set([
  '.claude',
  '.test-guard',
  'backups',
  'coverage',
  'data',
  'demo-library',
  'libraries',
  'playwright-report',
  'reference',
  'test-results',
])

export async function findTestFiles(root: string): Promise<TestFile[]> {
  const found: TestFile[] = []

  async function walk(relative: string) {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true })
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (SKIP_ANYWHERE.has(entry.name) || (!relative && SKIP_AT_ROOT.has(entry.name))) continue
        await walk(child)
      } else if (TEST_FILE.test(entry.name)) {
        found.push(describeTestFile(child, await readFile(path.join(root, child), 'utf8')))
      }
    }
  }

  await walk('')
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
  section('Errors', report.errors)

  return lines.join('\n')
}
