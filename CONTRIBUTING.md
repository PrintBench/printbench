# Contributing to PrintBench

Thanks for taking an interest. This file covers the things that are specific to
this repository — the general advice about being nice and writing clear commit
messages applies here too, but you already know it.

## The one firm rule: `reference/`

`reference/manyfold` is a vendored copy of [ManyFold](https://manyfold.app),
kept only as a **domain reference** for what a print library needs to model.

ManyFold is AGPL-3.0, and its `AGENTS.md` asks that AI agents not contribute to
that project. Neither of those binds this codebase, but both mean one rule that
is not negotiable:

> **No code is copied out of `reference/`.** Read it to understand the problem,
> then solve the problem yourself.

`reference/` is gitignored, dockerignored, excluded from the TypeScript build,
never linted and never formatted. Nothing imports from it. If you find yourself
wanting to relax any of that, open an issue first.

## Getting set up

```bash
npm install
cp .env.example .env
npm run db:up        # Postgres 18 on port 5433
npm run db:migrate
npm run dev          # web on :3000, worker alongside
```

You need Node 24 (see `.nvmrc`) and Docker for the database.

## Running the checks

CI runs exactly these, in this order. Run them before opening a pull request:

```bash
npm run lint
npm run typecheck
npm test
```

### `.env` matters more than you would expect

**A third of the test suite is database-backed, and those tests skip silently
when `DATABASE_URL` is unset.** `vitest.config.ts` loads `.env` if it is there,
so without one you will see a comfortable green run that proved much less than
you think:

```
Test Files  24 passed | 14 skipped (39)      <- no .env, no database
Test Files  39 passed (39)                   <- what a real run looks like
```

If your skip count is not zero, your database is not up. This bites hardest in a
git worktree, which does not inherit the `.env` from the main checkout.

### The verify scripts

These drive a running dev server end to end, creating throwaway accounts and
cleaning up after themselves. They are not part of CI beyond phase 1, but they
are the fastest way to know a change actually works:

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
```

Note that a verify script starts its own job queue. That means it can pass while
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

Bugs go in the issue tracker. **Security vulnerabilities do not** — see
[SECURITY.md](SECURITY.md).
