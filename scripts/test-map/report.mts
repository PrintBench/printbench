/**
 * `npm run test:map`: which real-world scenarios have a test behind them?
 *
 * Coverage gaps and unannotated files are reported but do not fail the run
 * unless `--strict` is passed. A catalogue or annotation that is simply wrong
 * always fails, because a typo would otherwise read as a missing test.
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

const strict = process.argv.includes('--strict')
if (report.errors.length > 0 || (strict && report.unannotated.length > 0)) process.exitCode = 1
