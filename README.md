# Print Manager

A self-hosted web app for managing and finding your 3D print files (STL, 3MF, OBJ, PLY).

Postgres is the **only** infrastructure dependency. No Redis, no message broker,
and no native 3D toolchain — thumbnails are rendered by a pure-TypeScript
rasterizer, so there is nothing to compile and nothing to install.

## Status

Phase 7 complete — print workflow.
See `docs/` and the plan for the phase roadmap.

| Phase | Scope | State |
|-------|-------|-------|
| 0 | Monorepo, schema, migrations, Docker, CI | done |
| 1 | Auth, roles, app shell | done |
| 2 | Libraries, scanning, browse | done |
| 3 | Geometry parsing and thumbnails | done |
| 4 | 3D viewer and downloads | done |
| 5 | Search and faceted filtering | done |
| 6 | Uploads and editing | done |
| 7 | Print history, open-in-slicer, send-to-printer | done |
| 8 | Library health and polish | next |

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
npm run verify:phase3      # mesh parsing, rendering and serving, needs `npm run dev`
npm run verify:phase4      # downloads, HTTP Range and ZIP archives, needs `npm run dev`
npm run verify:phase5      # search, facets and the command palette, needs `npm run dev`
npm run verify:phase6      # uploads, editing and the restore drill, needs `npm run dev`
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
- **No Elasticsearch.** Search is a weighted Postgres tsvector with a GIN index
  plus trigram matching for typos. Search state lives in the URL, so a filtered
  search is shareable and the back button works.
- **No native render toolchain.** A z-buffer software rasteriser streams
  triangles, so a 6GB STL renders in bounded memory — something neither headless
  Chromium nor headless-gl can do. It is also deterministic, so renders are
  golden-image tested, and identical on Windows and Linux.
- **Mesh parsing is pure TypeScript** — STL (binary and ASCII), 3MF, OBJ and
  PLY, with no compiled dependencies. A slicer-exported 3MF's embedded plate
  render is used in preference to rasterising.
- **Large downloads bypass Node** via `X-Accel-Redirect` to nginx, or a presigned
  URL on S3. Whole-model ZIPs are streamed from the worker process, stored
  rather than deflated, so an 8GB archive never occupies the web tier.
- **The 3MF parser is isomorphic** — the same code produces the server-side
  thumbnail and the in-browser view. three's own 3MFLoader cannot run in a Web
  Worker, because it depends on DOMParser.
- **Metadata is written back to disk** as a `.printmanager.json` sidecar per
  model, so the database can be rebuilt by rescanning. That restore drill is
  covered by tests, not just intent.
- **Uploads are resumable** (tus), handled by the worker so a multi-gigabyte
  transfer never occupies the web tier. Folder structure from a drag-and-drop
  is preserved, because that structure is what groups files into models.
- **Scanning refuses to destroy metadata.** If a scan would mark more than 20% of
  models missing — an unmounted NAS, say — it aborts and asks an admin.
- **Slicers are handed the file, not driven.** Every modern slicer registers a
  URL scheme, so `Open in…` covers Bambu Studio, Orca, PrusaSlicer, Cura and
  Lychee at once, and works for printers with no network API. This is also the
  honest answer for Bambu specifically: pushing to their printers means FTPS
  plus MQTT with LAN mode enabled, where Bambu Studio already knows how.
- **Slicer links are signed.** A desktop slicer fetches the URL as a separate
  application with none of our cookies, so the link carries a short-lived HMAC
  naming that one file, rather than the endpoint being opened up.
- **Printer credentials are encrypted at rest** (AES-256-GCM, keyed from
  `BETTER_AUTH_SECRET`), because an API key has to be replayed to the printer
  and so cannot be hashed. A database dump alone does not hand over the
  printers.
- **A success rate is null, not zero, until something settles.** A model whose
  only print is still running has no verdict yet, and showing 0% reads as a
  failure.

## Print workflow

- **Log a print** from any model page: printer, material, colour, layer height,
  nozzle, start and finish times, filament used, a 1–5 rating and notes. The
  duration is worked out from the timestamps unless you type one. `/prints`
  is the library-wide log, filterable by outcome, and search has a
  **never printed** facet.
- **Open in…** appears on any file a slicer reads, and launches it with the
  file loaded.
- **Send** appears on sliced files (`gcode`, `bgcode`, `sl1`, `ctb`, `3mf`) once
  an admin has added a printer under **Manage → Printers**. OctoPrint,
  Moonraker and PrusaLink are supported, with an optional "start on arrival".
  Test the connection from the same page — it reports what is actually wrong
  ("Could not resolve …", "The printer rejected the API key") rather than
  "fetch failed".

## Notes on `reference/`

`reference/manyfold` is a vendored copy of [ManyFold](https://manyfold.app),
used only as a **domain reference** for what a print library needs to model.

ManyFold is AGPL-3.0 and its `AGENTS.md` asks that AI agents not contribute to
that project. Neither affects this codebase, but both mean one firm rule: **no
code is copied from it.** `reference/` is gitignored, dockerignored and excluded
from the TypeScript build, and nothing here imports from it.
