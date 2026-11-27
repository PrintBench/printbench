/**
 * Claude Code PostToolUse hook: tells the agent straight away when a test file
 * it just wrote breaks docs/testing.md, instead of leaving CI to say so later.
 *
 * Early feedback only. It does not see files changed through a shell command,
 * and CI is what actually enforces the rules.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { text } from 'node:stream/consumers'
import { buildReport, findTestFiles, TEST_FILE } from './lib.js'

const CATALOGUE = 'tests/scenarios/catalogue.json'

const input = JSON.parse(await text(process.stdin)) as { tool_input?: { file_path?: string } }
const file = input.tool_input?.file_path
if (!file || !(TEST_FILE.test(file) || file.endsWith(CATALOGUE))) process.exit(0)

// Found from the edited file, because a session in a worktree edits a different
// checkout from the one this script is loaded from.
let root = path.dirname(file)
while (!existsSync(path.join(root, CATALOGUE))) {
  if (path.dirname(root) === root) process.exit(0)
  root = path.dirname(root)
}

const edited = path.relative(root, file).split(path.sep).join('/')
const { errors } = buildReport(
  JSON.parse(await readFile(path.join(root, CATALOGUE), 'utf8')),
  await findTestFiles(root),
)
const relevant =
  edited === CATALOGUE ? errors : errors.filter((error) => error.startsWith(`${edited}: `))

if (relevant.length > 0) {
  console.error(
    `This does not follow docs/testing.md. Fix the test, or tell the user why you cannot;\n` +
      `do not change the rules to make it pass.\n${relevant.join('\n')}`,
  )
  // Exit code 2 is what returns stderr to the agent.
  process.exit(2)
}
