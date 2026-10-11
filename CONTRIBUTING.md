# Contributing to PrintBench

Thanks for taking an interest. This file covers the things that are specific to
this repository — the general advice about being nice and writing clear commit
messages applies here too, but you already know it.

## Getting set up

```bash
npm ci
cp .env.example .env
npm run db:up        # Postgres 18 on port 5433
npm run db:migrate
npm run dev          # web on :3000, worker alongside
```

Use Node 24 (see `.nvmrc`), the version CI tests, and Docker for the database.
The package engine declares Node 22 as the minimum, but CI currently verifies
Node 24 only.

## Running the checks

Start and migrate the development database, then run the standard local checks:

```bash
npm run db:up
npm run db:migrate
npm run check
```

`npm run check` runs formatting, lint, typechecking, release preparation tests
and the application test suite, in that order.
You can also run each check separately:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:release
npm test
```

CI runs release preparation tests, applies migrations, runs formatting, lint,
typechecking and the unit and integration suites, builds the web app, and runs
`verify:smoke` against the production web server and real worker. The smoke
suite includes the existing `verify:phase1` authentication checks. A separate
CI job builds the Docker image. The local `check` command does not start a server or build images.
For changes affecting builds, also run `npm run build`.

### Unit and integration tests

```bash
npm run test:unit          # no Postgres required
npm run test:integration   # database-backed tests only
npm test                  # both kinds of test
npm run test:watch        # both kinds, in watch mode
```

`npm test`, `npm run test:integration`, `npm run test:watch` and `npm run check`
require `DATABASE_URL`. They load `.env` when present and fail at startup with
setup instructions if the variable is missing or blank. Copy `.env.example` to
`.env`, start the development database and apply migrations first. A git
worktree does not inherit `.env` from the main checkout.

Use a disposable development/test database: integration fixtures write data,
and some tests clear shared tables. Never point these commands at production.

Database suites use Vitest's `integration` tag, including in files that also
contain pure tests. The unit command excludes that tag and the integration
command selects it. Skipped tests in these filtered runs are expected; the full
`npm test` run should execute both sets. Unit runs do not load `.env` or connect
to Postgres, even when `DATABASE_URL` is already set.

When adding a database suite, tag it explicitly:

```ts
describe('database behaviour', { tags: ['integration'] }, () => {
  // Create connections and fixtures in beforeAll, not during collection.
})
```

CI runs unit and integration tests as separate steps against its migrated
Postgres service so each result is visible.

### Browser smoke tests

After building the web app, run the browser smoke suite against an empty,
migrated test database:

```bash
npx playwright install chromium
npm run build -w @pb/web
DATABASE_URL=postgres://printbench:printbench@localhost:5433/printbench npm run verify:smoke
```

Use a disposable Postgres database. The suite refuses a database containing
users or libraries before starting the worker. Ports 3000 and 3001 must be free;
it starts and stops its own production web server and worker and uses a shared
temporary directory for library files, uploads and previews. It does not reuse
an existing app server. Both app processes use a fixed test-only auth secret.

The browser clicks the real scan and upload controls; the verifier never starts
a job queue or mints its own upload ticket. It waits for the worker to finish,
checks the model pages and thumbnail delivery, and tests permission revocation
on an already-open admin page. It also reruns the phase 1 authentication checks.
Generated account and library rows are removed in `finally`; temporary files
are removed during teardown. Force-killed runs may leave fixtures, so discard
the test database before another run.

CI installs Chromium and runs this suite after the unit/integration tests and
web build. Failure screenshots are kept as a `smoke-failures` Actions artifact
for seven days. `npm run check` does not launch the browser suite.

### The verify scripts

These drive a running dev server end to end, creating throwaway accounts and
cleaning up after themselves. The phase scripts beyond phase 1 are not part of
CI; the browser smoke suite covers selected scan, upload and permission flows.
Use the phase scripts to check changes to their individual surfaces:

```bash
npm run dev          # in another terminal, for everything past phase 1
npm run verify:phase1   # auth and role guards
npm run verify:phase2   # scan pipeline and safety guards
npm run verify:phase3   # mesh parsing, rendering and serving
npm run verify:phase4   # downloads, HTTP Range and ZIP archives
npm run verify:phase5   # search, facets and the command palette
npm run verify:phase6   # uploads, editing and the restore drill
npm run verify:phase7   # print history, slicer links and a stubbed printer
npm run verify:phase8   # health, settings, schedules, sharing and prune
npm run verify:phase9   # print queue, roles and auto-linking
```

Several phase verification scripts start their own job queue. That means it can pass while
the same flow is broken in the browser, because the web process has a queue of
its own — if you are changing anything queue-shaped, check the UI too.

## How the code is laid out

```
apps/web       Next.js — UI, auth, thin API layer
apps/worker    Plain Node — scanning, thumbnails, uploads, ZIP streaming
packages/db    Drizzle schema and migrations
packages/core  Domain logic: storage, grouping, search, policy
packages/mesh  STL/3MF/OBJ/PLY parsers and the thumbnail rasteriser
packages/jobs  pg-boss wrapper
packages/auth  better-auth wrapper
```

Domain logic lives in the framework-free packages so that both processes can
import it and the web shell stays replaceable. **New domain logic belongs in
`packages/`, not in a route handler.** If a rule about what a library _is_ ends
up in `apps/web`, the worker cannot enforce it.

## Things worth knowing before you change them

- **The web tier never does heavy I/O.** Large downloads bypass Node entirely
  and multi-gigabyte work happens in the worker. A change that streams a big
  file through a Next.js route is a change in the wrong direction.
- **Renders are golden-image tested.** The rasteriser is deterministic on
  purpose, so identical input gives identical bytes on Windows and Linux. If a
  golden test fails, the render genuinely changed — do not refresh the fixture
  without understanding why.
- **Migrations are generated, not hand-written.** Use `npm run db:generate`
  after editing the schema, and commit what it produces.
- **`packages/db/src/schema/auth.ts` is reconciled against better-auth itself**,
  not its CLI, which lags. After upgrading better-auth run `npm run auth:schema`.
- **Scans refuse to destroy metadata.** The 20%-missing abort and the
  all-missing prune guard exist because an unmounted NAS looks exactly like a
  mass deletion. Please do not "simplify" them away.

## Commits and pull requests

- Keep a pull request to one subject. A drive-by fix in an unrelated file is
  genuinely welcome, just not in the same PR.
- Explain **why** in the commit message. The codebase's comments are written
  that way and it is the convention worth keeping.
- New behaviour comes with a test. The suite is fast, so this is cheap.
- Formatting is Prettier's problem, not yours or a reviewer's: `npm run format`.

## Reporting bugs and security issues

Use [SUPPORT.md](SUPPORT.md) to choose between a bug report, feature request
and setup question. Maintainers can follow [the triage guide](docs/maintaining.md).
**Security vulnerabilities do not go in the issue tracker** — see
[SECURITY.md](SECURITY.md).

## Community conduct

Follow the [Code of Conduct](CODE_OF_CONDUCT.md) in issues, pull requests and
other project spaces. Report unacceptable behaviour privately to
[support@owl-media.co.uk](mailto:support@owl-media.co.uk).

## Releasing

Follow the [release checklist](docs/releasing.md) for versioning, authored notes,
prereleases and recovery. Releases validate the tagged commit with the same CI
workflow before publishing images or a GitHub release. `npm run release:check --
v<version>` checks release metadata locally without publishing.
