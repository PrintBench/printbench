/**
 * Which files actually run.
 *
 * vitest.config.ts and playwright.config.ts take their patterns from here, so a
 * test file the report counts is a test file CI executes. Before this was
 * shared, a `.spec.ts` that nothing ran still counted as browser coverage.
 */
export const VITEST_ROOTS = ['packages', 'apps', 'scripts']
export const VITEST_INCLUDE = VITEST_ROOTS.map((root) => `${root}/**/*.test.ts`)

export const PLAYWRIGHT_DIR = 'scripts/smoke'
export const PLAYWRIGHT_MATCH = '**/*.spec.ts'

/** Run by `node --test` from package.json, outside both frameworks. */
export const NODE_TESTS = ['scripts/release-metadata.test.mjs']

export type Runner = 'vitest' | 'playwright' | 'node'

/** `file` is a repository-relative path with forward slashes. */
export function runnerFor(file: string): Runner | null {
  if (NODE_TESTS.includes(file)) return 'node'
  if (file.startsWith(`${PLAYWRIGHT_DIR}/`) && file.endsWith('.spec.ts')) return 'playwright'
  if (file.endsWith('.test.ts') && VITEST_ROOTS.some((root) => file.startsWith(`${root}/`))) {
    return 'vitest'
  }
  return null
}
