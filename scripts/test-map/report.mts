/**
 * `npm run test:map`: which real-world scenarios have a test behind them, and
 * does every test file follow the rules?
 *
 * Coverage gaps are listed but do not fail the run. A test that never runs,
 * proves nothing or claims something that does not exist always does.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { buildReport, findTestFiles, formatReport } from './lib.js'

const root = path.resolve(import.meta.dirname, '../..')
const catalogue: unknown = JSON.parse(
  await readFile(path.join(root, 'tests/scenarios/catalogue.json'), 'utf8'),
)
const report = buildReport(catalogue, await findTestFiles(root))

console.log(formatReport(report))

if (report.errors.length > 0) process.exitCode = 1
