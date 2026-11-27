# Testing policy

For anyone, person or agent, about to add, change or delete a test. How to run
the suites is in [CONTRIBUTING.md](../CONTRIBUTING.md).

A test is worth having when it would fail if something a user does broke, or if
a rule a module promises stopped holding. A test that mirrors the code it was
written beside costs time on every run and every refactor, and proves nothing.

## Before writing a test

1. **Name what it stands behind.** A scenario in
   [`tests/scenarios/catalogue.json`](../tests/scenarios/catalogue.json), a bug,
   or a module contract listed there. If you cannot name one, either there is
   nothing to test or the catalogue is missing something: say so and ask. Do not
   invent an entry to make room for a test.
2. **Look for the test that already exists** (`npm run test:map`, then search).
   Extend it. A new file needs a reason an existing one will not do.
3. **Pick the layer that would catch the failure**, and only that one.

| The risk is that...                        | Write                                             |
| ------------------------------------------ | ------------------------------------------------- |
| a user can no longer do something          | a browser spec in `scripts/smoke/`                |
| a rule over stored data is wrong           | an integration test in `packages/`, real Postgres |
| a parser or pure function mishandles input | a table of inputs in a unit test                  |

"No new test" is a correct answer. A refactor that keeps behaviour is covered by
the tests already there, as is a change to wording, styling or configuration that
nothing can observe breaking.

## Do not

- Replace modules with `vi.mock`. Pass the dependency in, as core does with
  `fetchImpl`. A replaced module hides the wiring that tends to break.
- Assert which internal function was called when you can assert what happened.
- Restate a constant (`expect(THRESHOLD).toBe(0.2)`). Test what it causes.
- Repeat at one layer what another already proves.
- Skip, focus or delete a test to get a change through. If a test is wrong, say
  why in the pull request and let the maintainer decide.

## Bug fixes

Add a test annotated `@bug`, and **watch it fail without the fix** before keeping
it. Say in the pull request how you saw it fail. If users could see the bug, add
a `BUG-<hash or issue>` scenario too.

## Annotations

Every test file starts with at least one of:

```ts
// @covers SCAN-001 SEARCH-002   scenarios from the catalogue
// @bug 609569b                  the fix commit or #issue it guards against
// @contract mesh/stl            a module's own rules, no single user journey
```

Claim `@covers` only when the test would fail if that scenario broke in the way
it describes. New user-facing behaviour adds or extends a scenario in the same
pull request: `tier` is `pr` for journeys that must never break, `nightly` for
the rest.

## What is enforced

**`npm run test:map`** runs in CI and fails on:

- a test file that no runner picks up
- a missing annotation, or one naming a scenario or contract that does not exist
- a contract in the catalogue that no test claims
- `.skip`, `.only`, `.todo` and their relatives
- a file with no tests, a test with no assertion, or an assertion on a literal

An assertion is a call to something named `expect…` or `assert…`, in the test
body itself.

**`npm run test:guard -- --base origin/main`** compares a pull request with its
base and fails when it:

- edits the rules: this file, `AGENTS.md`, the catalogue, `scripts/test-map/`,
  the Vitest or Playwright configuration, `.claude/settings.json`, a workflow
  (action version bumps excepted) or a test script in `package.json`
- deletes tests, adds a `vi.mock`, or leaves a scenario with weaker coverage

Those are not forbidden. They need a maintainer to agree, by adding the
`test-policy` label and re-running the failed job. **Agents must not add that
label**, or change a rule to make their own change pass. The label covers the
whole pull request, including commits pushed after it was added, so it belongs on
last.

CI judges a pull request with the copy of these scripts already on `main`.

## What nothing checks

No script can tell whether a test is meaningful. The checks stop empty, hidden
and weakened tests. Whether a new test would catch a real failure is for the
reviewer to ask.
