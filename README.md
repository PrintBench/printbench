# Print Manager

A self-hosted web app for managing and finding your 3D print files (STL, 3MF, OBJ, PLY).

Postgres is the **only** infrastructure dependency. No Redis, no message broker,
and no native 3D toolchain — thumbnails are rendered by a pure-TypeScript
rasterizer, so there is nothing to compile and nothing to install.

## Status

Phase 2 complete — libraries, scanning and browsing.
See `docs/` and the plan for the phase roadmap.

| Phase | Scope | State |
|-------|-------|-------|
| 0 | Monorepo, schema, migrations, Docker, CI | done |
| 1 | Auth, roles, app shell | done |
| 2 | Libraries, scanning, browse | done |
| 3 | Geometry parsing and thumbnails | next |
| 4 | 3D viewer and downloads | |
| 5 | Search and faceted filtering | |
| 6 | Uploads and editing | |
| 7 | Print history, open-in-slicer, send-to-printer | |
| 8 | Library health and polish | |

## Quick start (Docker)

```bash
cp .env.example .env
# set POSTGRES_PASSWORD, BETTER_AUTH_SECRET (openssl rand -base64 32)
# and LIBRARY_PATH to the folder holding your print files
docker compose up -d
```

Then open <http://localhost:8080>.

Your library is mounted **read-only**. The app indexes it and never moves,
renames or deletes anything in it.

## Local development

```bash
npm install
npm run db:up        # Postgres 18 on port 5433
npm run db:migrate
npm run dev          # web on :3000, worker alongside
```

Run the test suite (needs the dev database up — `.env` is loaded automatically):

```bash
npm test
```

End-to-end check of the authenticated surface against a running dev server. It
creates a throwaway account, exercises the role guards in both directions, and
cleans up after itself:

```bash
npm run verify:phase1
npm run verify:phase2      # scan pipeline and safety guards
npm run verify:phase2:ui   # web -> queue -> worker -> pages, needs `npm run dev`
```

After upgrading better-auth, reconcile `packages/db/src/schema/auth.ts` against
what the library actually expects — its CLI lags the library version, so this is
the authoritative source:

```bash
npm run auth:schema
```

## Layout

```
apps/web       Next.js — UI, auth, thin API layer
apps/worker    Plain Node — scanning, thumbnails, uploads, ZIP streaming
packages/db    Drizzle schema and migrations
packages/core  Domain logic: storage, grouping, search, policy
packages/mesh  STL/3MF/OBJ/PLY parsers and the thumbnail rasterizer
packages/jobs  pg-boss wrapper
packages/auth  better-auth wrapper
```

Domain logic lives in framework-free packages that both processes import, so the
web shell is replaceable without touching the app.

## Design decisions

- **No Redis.** Jobs run on pg-boss, backed by Postgres.
- **No native render toolchain.** A z-buffer software rasterizer streams
  triangles, so a 6GB STL renders in bounded memory — something neither headless
  Chromium nor headless-gl can do.
- **Large downloads bypass Node** via `X-Accel-Redirect` to nginx, or a presigned
  URL on S3.
- **Metadata is written back to disk** as a `.printmanager.json` sidecar per
  model, so the database can be rebuilt by rescanning.
- **Scanning refuses to destroy metadata.** If a scan would mark more than 20% of
  models missing — an unmounted NAS, say — it aborts and asks an admin.

## Notes on `reference/`

`reference/manyfold` is a vendored copy of [ManyFold](https://manyfold.app),
used only as a **domain reference** for what a print library needs to model.

ManyFold is AGPL-3.0 and its `AGENTS.md` asks that AI agents not contribute to
that project. Neither affects this codebase, but both mean one firm rule: **no
code is copied from it.** `reference/` is gitignored, dockerignored and excluded
from the TypeScript build, and nothing here imports from it.
