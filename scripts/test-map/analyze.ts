/**
 * Reads what a test file really contains, from its syntax tree.
 *
 * Pattern matching on the text was not enough: a tag or a `.skip` quoted inside
 * a string looked the same as a real one, and nothing noticed a test that
 * asserted nothing.
 */
import ts from 'typescript'

export interface Analysis {
  /** Comments above the first statement, where annotations live. */
  header: string
  /** Tests declared. A table or a loop counts once. */
  tests: number
  /** `vi.mock` and `vi.doMock` calls: each one replaces a real module. */
  mocks: number
  /** Whether a suite is tagged as running against Postgres. */
  integration: boolean
  /** Things that make a test pass without proving anything. */
  problems: string[]
}

const SUITE_OR_TEST = new Set(['it', 'test', 'describe', 'suite'])
const TEST = new Set(['it', 'test'])
const DISABLING = new Set(['skip', 'only', 'todo', 'fails', 'fixme', 'skipIf', 'runIf'])
/** Members of `it`/`test` that take a callback but declare no test. */
const NOT_A_TEST = new Set([
  'describe',
  'step',
  'use',
  'extend',
  'beforeAll',
  'beforeEach',
  'afterAll',
  'afterEach',
  'setTimeout',
  'slow',
])
// A helper counts as an assertion when its name says it is one.
const ASSERTION = /^(?:expect|assert)/

/** `it.each(rows)('name', fn)` reads as ['it', 'each']. */
function chain(node: ts.Expression): string[] {
  if (ts.isIdentifier(node)) return [node.text]
  if (ts.isPropertyAccessExpression(node)) return [...chain(node.expression), node.name.text]
  if (ts.isCallExpression(node)) return chain(node.expression)
  if (ts.isTaggedTemplateExpression(node)) return chain(node.tag)
  return []
}

function contains(node: ts.Node, predicate: (child: ts.Node) => boolean): boolean {
  return (
    predicate(node) || (ts.forEachChild(node, (c) => contains(c, predicate) || undefined) ?? false)
  )
}

const isAssertion = (node: ts.Node) =>
  ts.isCallExpression(node) && chain(node.expression).some((part) => ASSERTION.test(part))

function isLiteral(node: ts.Expression): boolean {
  return (
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  )
}

function hasProperty(node: ts.Expression, name: string, value: (v: ts.Expression) => boolean) {
  return (
    ts.isObjectLiteralExpression(node) &&
    node.properties.some(
      (property) =>
        ts.isPropertyAssignment(property) &&
        property.name.getText() === name &&
        value(property.initializer),
    )
  )
}

export function analyze(file: string, source: string): Analysis {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const header = (ts.getLeadingCommentRanges(source, 0) ?? [])
    .map((range) => source.slice(range.pos, range.end))
    .join('\n')
  const result: Analysis = { header, tests: 0, mocks: 0, integration: false, problems: [] }

  const problem = (node: ts.Node, message: string) => {
    const { line } = tree.getLineAndCharacterOfPosition(node.getStart())
    result.problems.push(`line ${line + 1}: ${message}`)
  }

  function inspect(call: ts.CallExpression) {
    const parts = chain(call.expression)
    const [root = '', ...members] = parts
    const [first, second] = call.arguments

    if (root === 'vi' && (members[0] === 'mock' || members[0] === 'doMock')) result.mocks++

    if (root === 'xit' || root === 'xdescribe') problem(call, `${root} disables a test`)

    // `it.skip.each(rows)(...)` is two calls on one chain. Only the inner one
    // names the member, so report from there and not again from the outer call.
    if (
      SUITE_OR_TEST.has(root) &&
      !ts.isCallExpression(call.expression) &&
      members.some((member) => DISABLING.has(member))
    ) {
      problem(call, `${parts.join('.')} disables or narrows tests`)
    }

    if (SUITE_OR_TEST.has(root)) {
      for (const argument of call.arguments) {
        for (const option of ['skip', 'only', 'todo']) {
          if (hasProperty(argument, option, (v) => v.kind === ts.SyntaxKind.TrueKeyword)) {
            problem(call, `{ ${option}: true } disables or narrows tests`)
          }
        }
        const tagged = hasProperty(
          argument,
          'tags',
          (v) =>
            ts.isArrayLiteralExpression(v) &&
            v.elements.some((e) => ts.isStringLiteralLike(e) && e.text === 'integration'),
        )
        if (tagged) result.integration = true
      }
    }

    const declaresTest =
      TEST.has(root) &&
      !members.some((member) => NOT_A_TEST.has(member)) &&
      first !== undefined &&
      second !== undefined &&
      !ts.isArrowFunction(first) &&
      !ts.isFunctionExpression(first)

    if (declaresTest) {
      result.tests++
      const body = call.arguments.find(
        (a): a is ts.ArrowFunction | ts.FunctionExpression =>
          ts.isArrowFunction(a) || ts.isFunctionExpression(a),
      )
      if (!body) problem(call, 'the test body is not inline, so its assertions cannot be seen')
      else if (!contains(body, isAssertion)) problem(call, 'test asserts nothing')
    }

    // expect(true).toBe(true) passes whatever the product does.
    if (root === 'expect' && parts.length === 1 && first && isLiteral(first)) {
      problem(call, 'asserts on a literal value')
    }
  }

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) inspect(node)
    ts.forEachChild(node, visit)
  }
  visit(tree)

  return result
}
