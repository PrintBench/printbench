/**
 * What would this change loosen?
 *
 * The report says whether the tests follow the rules. It cannot say whether the
 * rules, or the tests that were already there, have been weakened to get a
 * change through. That takes a comparison with the base branch, and anything
 * found here needs a person to agree to it.
 */
import { buildReport, LEVELS, type Level, type TestFile } from './lib.js'

export interface Snapshot {
  catalogue: unknown
  files: TestFile[]
  /** `scripts` from the root package.json. */
  scripts: Record<string, string>
}

export interface Change {
  path: string
  /** The path on the base branch, when the file was renamed. */
  from?: string
  /** Contents on each side, only needed for workflow files. */
  before?: string
  after?: string
}

/** The files that decide what counts as a passing test run. */
export const PROTECTED = [
  '.claude/settings.json',
  '.github/workflows/',
  'AGENTS.md',
  'docs/testing.md',
  'playwright.config.ts',
  'scripts/test-map/',
  'tests/scenarios/',
  'vitest.config.ts',
]

const TEST_SCRIPT = /^(?:test(?::.+)?|check|verify:smoke)$/

/**
 * Dependabot bumps action versions every week. Moving `actions/checkout@v7` to
 * `@v8` changes no rule; swapping which action runs, or anything else, does.
 */
function onlyActionVersions({ before, after }: Change): boolean {
  if (before === undefined || after === undefined) return false
  const unversioned = (text: string) =>
    text.replace(/^(\s*(?:- )?uses: [^\s@]+)@\S+(?: +#.*)?$/gm, '$1')
  return unversioned(before) === unversioned(after)
}

const rank = (level: Level | 'none') => (level === 'none' ? LEVELS.length : LEVELS.indexOf(level))

export function weakenings(base: Snapshot, head: Snapshot, changes: Change[]): string[] {
  const found: string[] = []

  for (const change of changes) {
    const paths = [change.path, change.from ?? change.path]
    const guarded = paths.some((p) =>
      PROTECTED.some((rule) => (rule.endsWith('/') ? p.startsWith(rule) : p === rule)),
    )
    if (!guarded) continue
    if (change.path.startsWith('.github/workflows/') && onlyActionVersions(change)) continue
    found.push(`${change.path}: changes the test rules`)
  }

  for (const [name, command] of Object.entries(base.scripts)) {
    if (TEST_SCRIPT.test(name) && head.scripts[name] !== command) {
      found.push(`package.json: changes or removes the "${name}" script`)
    }
  }

  const headFiles = new Map(head.files.map((file) => [file.path, file]))
  const baseFiles = new Map(base.files.map((file) => [file.path, file]))
  const renamedTo = new Map(changes.flatMap((c) => (c.from ? [[c.from, c.path] as const] : [])))
  const renamedFrom = new Map(changes.flatMap((c) => (c.from ? [[c.path, c.from] as const] : [])))

  for (const before of base.files) {
    const after = headFiles.get(renamedTo.get(before.path) ?? before.path)
    if (!after) {
      found.push(`${before.path}: deleted, taking ${before.tests} test(s) with it`)
    } else if (after.tests < before.tests) {
      found.push(`${after.path}: ${before.tests - after.tests} fewer test(s) than before`)
    }
  }

  for (const after of head.files) {
    const had = baseFiles.get(renamedFrom.get(after.path) ?? after.path)?.mocks ?? 0
    if (after.mocks > had) {
      found.push(
        `${after.path}: replaces more modules with vi.mock (${had} before, ${after.mocks})`,
      )
    }
  }

  const levels = new Map(
    buildReport(head.catalogue, head.files).scenarios.map((r) => [r.scenario.id, r.level]),
  )
  for (const row of buildReport(base.catalogue, base.files).scenarios) {
    const now = levels.get(row.scenario.id)
    if (now !== undefined && rank(now) > rank(row.level)) {
      found.push(`${row.scenario.id}: strongest test drops from ${row.level} to ${now}`)
    }
  }

  return found
}
