# PrintBench

Self-hosted web app for managing and finding 3D print files (STL, 3MF, OBJ, PLY). Postgres is the only
external dependency. npm-workspaces monorepo, TypeScript (strict), ESM, Node 24 (`.nvmrc`; engines says >=22).

Prefer explaining **why** in commit messages and comments; that is the repo convention.
Full contributor guide: `CONTRIBUTING.md`. Maintainer/branch policy: `docs/maintaining.md`.

## Architecture map

```
apps/web        Next.js (@pb/web) - UI, auth, thin API layer. app/ has (app), (auth), api, share routes
apps/worker     Plain Node (@pb/worker) - scanning, thumbnails, uploads, ZIP streaming, backups, watcher
packages/db     Drizzle schema (src/schema/*) and generated migrations (@pb/db)
packages/core   Framework-free domain logic: storage, library, scan, search, policy, sidecar, import...
packages/mesh   STL/3MF/OBJ/PLY parsers and deterministic thumbnail rasteriser
packages/jobs   pg-boss queue wrapper
packages/auth   better-auth wrapper
packages/filament-catalog  Bundled Open Filament Database snapshot + normaliser (worker-only)
scripts/        verify-phase*.mts end-to-end checks, smoke helpers, backup, release metadata
docker/         Dockerfile, nginx, entrypoints (compose files live at the repo root)
reference/      AGPL material, gitignored: NEVER lint, import, build or ship it
```

Two processes (web + worker) share one Postgres. Domain rules live in `packages/` so both can enforce them.

## Commands

```bash
npm ci && cp .env.example .env     # first-time setup (set BETTER_AUTH_SECRET, see .env.example)
npm run db:up                      # dev Postgres 18 on :5433 (docker-compose.dev.yml)
npm run db:migrate                 # apply migrations
npm run dev                        # web on :3000 + worker, concurrently

npm run test:unit                  # no Postgres needed - the fast default while iterating
npm test                           # unit + integration; needs DATABASE_URL and a migrated DB
npm run test:integration           # database-backed tests only
npm run check                      # format:check, lint, typecheck, test:release, test (CI-equivalent minus build/smoke)
npm run build                      # run too when touching build-affecting code
npm run format                     # Prettier (no semicolons, single quotes, width 100)
npm run db:generate                # regenerate migration after editing the Drizzle schema
```

- `npm test`, `test:integration`, `test:watch` and `check` fail at startup without `DATABASE_URL`. A git
  worktree does **not** inherit `.env`; copy it in.
- Integration tests write to and clear shared tables: use a disposable dev DB, never production.
- Single test file: `npx vitest run path/to/file.test.ts` (add `--mode unit` to skip the DB requirement).
- Browser smoke: `npx playwright install chromium && npm run build -w @pb/web && npm run verify:smoke`
  against an empty migrated DB; needs ports 3000 and 3001 free. Not part of `npm run check`.
- `npm run verify:phaseN` scripts drive a running `npm run dev`; they are not in CI beyond phase 1.
  A passing script can still hide a broken UI flow because it runs its own job queue.

## Code standards

- Tests: Vitest, co-located `*.test.ts`. New behaviour ships with a test. Any suite touching Postgres must
  be tagged: `describe('...', { tags: ['integration'] }, () => {...})`, with fixtures created in `beforeAll`.
- Unused bindings that are intentional are prefixed `_` (ESLint). Lint is deliberately not type-aware;
  `npm run typecheck` is the real compiler gate.
- Web alias `@/` points at `apps/web`.
- **New domain logic goes in `packages/`, not in a route handler.** If a rule about what a library _is_
  lives in `apps/web`, the worker cannot enforce it.
- **Next.js here is not the version you know.** Before writing web code, read the relevant guide in
  `node_modules/next/dist/docs/` (see `apps/web/AGENTS.md`).

## Invariants - do not "simplify" these away

- The web tier never does heavy I/O. Large downloads bypass Node (nginx X-Accel / S3 presigned URLs); multi-GB
  work belongs in the worker. Never stream a big file through a Next.js route.
- Renders are golden-image tested and deterministic on purpose. If a golden test fails the render really
  changed: understand why before refreshing the fixture.
- Migrations are generated (`npm run db:generate`), never hand-written; commit the output.
- `packages/db/src/schema/auth.ts` is reconciled against better-auth itself: run `npm run auth:schema` after
  upgrading better-auth.
- Scans refuse to destroy metadata (20%-missing abort, all-missing prune guard) because an unmounted NAS
  looks like a mass deletion. Existing libraries are mounted read-only by default.
- Search has two known traps (single-token filenames, trigram operator direction): read
  `docs/search-notes.md` before changing search.

## Workflow

- `main` is protected: all changes go through a PR; required CI checks are `verify` and `docker`. Keep PRs to
  one subject, and keep CI job names stable (branch protection depends on them).
- Releases follow `docs/releasing.md`; `npm run release:check -- v<version>` validates metadata locally.
- Never commit secrets or `.env`. Security issues are reported privately per `SECURITY.md`, not as issues.

## More detail

`docs/deployment.md`, `docs/s3-storage.md`, `docs/model-imports.md`, `docs/model-packages.md`,
`docs/worker-memory.md`, `docs/filament-catalog.md` (bundled offline filament data; refreshed per release). User-facing docs live at https://docs.printbench.app (separate repo).
