# PrintBench

**Your 3D printing workspace.**

A self-hosted web app for managing and finding your 3D print files (STL, 3MF, OBJ, PLY).

Postgres is the **only** infrastructure dependency. No Redis, no message broker,
and no native 3D toolchain — thumbnails are rendered by a pure-TypeScript
rasterizer, so there is nothing to compile and nothing to install.

## Quick start (Docker)

```bash
cp .env.example .env
# set POSTGRES_PASSWORD, BETTER_AUTH_SECRET (openssl rand -base64 32)
# and LIBRARY_PATH to the folder holding your print files
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
```

Then open <http://localhost:8080>.

Your library is mounted **read-only**. The app indexes it and never moves,
renames or deletes anything in it.

For Coolify, NAS mounts, backups and upgrades, see
[docs/deployment.md](docs/deployment.md). For putting a library in a bucket —
bucket, IAM policy, CORS and per-provider settings — see
[docs/s3-storage.md](docs/s3-storage.md).

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
npm run verify:phase7      # print history, slicer links and a stubbed printer, needs `npm run dev`
npm run verify:phase8      # health, settings, schedules, sharing and prune, needs `npm run dev`
```

Lint the workspace:

```bash
npm run lint
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
- **Metadata is written back to disk** as a `.printbench.json` sidecar per
  model, so the database can be rebuilt by rescanning. That restore drill is
  covered by tests, not just intent. The file is also a declaration: drop one
  into a folder by hand and that folder becomes a single model, whatever the
  grouping heuristic would otherwise make of it — which is how you stop a pack
  with subfolders from splitting into one model per subfolder. The app never
  writes one into a folder that has models inside it, so editing a tag cannot
  merge them behind your back.
- **Uploads are resumable** (tus), handled by the worker so a multi-gigabyte
  transfer never occupies the web tier. Folder structure from a drag-and-drop
  is preserved, because that structure is what groups files into models. A
  `.zip` is extracted server-side rather than stored whole, with a zip-slip
  guard on every entry, so a downloaded pack can be dropped in as one file.
- **S3 is a full backend, not just a source.** A library can live on local
  disk, a NAS mount or an S3-compatible bucket, and read _and_ write the same
  either way — uploads, zip extraction, sidecars and deletion all go through
  one storage interface. Uploads to a bucket are multipart, so peak memory is
  the in-flight window (32 MB) rather than the size of the file; verified at
  128 MB against MinIO with `npm run verify:s3`.
- **Scanning refuses to destroy metadata.** If a scan would mark more than 20% of
  models missing — an unmounted NAS, say — it aborts and asks an admin. The
  nightly prune additionally refuses to touch a library where _every_ model is
  missing, whatever the grace period says, because that is an unplugged drive
  rather than a deletion.
- **Scan schedules are evaluated, not registered.** pg-boss keeps one schedule
  per queue name, so per-library crons are decided by a sweep comparing the last
  fire time against the last scan. A schedule change takes effect at once, and a
  scan missed while the worker was down is picked up rather than skipped.
- **Live watching is optional and off by default**, per library, on top of the
  schedule. Recursive watching costs one inotify watch per directory and can
  exceed the OS limit on a very large library, so it's opt-in rather than
  assumed. The worker reconciles its active watchers against the database on
  the same kind of sweep as the scan schedule, so turning it on or off in the
  UI takes effect within a minute with nothing to restart.
- **Slicer hand-off converts to 3MF.** Bambu Studio's URL handler refuses any
  extension but `.3mf`, and checks _before_ downloading — so a link to an STL
  fails without a request ever reaching the server. Meshes are repackaged as
  3MF on the way out, which every other slicer reads too. An existing 3MF is
  passed through untouched, so a project keeps its plates and painted supports.
  Geometry is preserved; colour on an OBJ or PLY is not, and the UI says so.
- **The link only appears where it can work.** Because delivery is always 3MF,
  the question is what _we_ can convert (STL, OBJ, PLY, 3MF) rather than what
  each slicer reads. STEP is the difference: slicers open it happily, we cannot
  produce a 3MF from it without a CAD kernel, so no link is offered. The offer
  and the converter share one list precisely so they cannot drift.
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

## Browsing

Beyond search there are four ways in, all reachable from the sidebar:

- **Creators** — who made what, with everything of theirs you own.
- **Tags** — with the management that keeps them usable: rename, recolour,
  delete, and **merge**, which is the one that matters. Tags arrive from
  filenames, sidecars and typing, so a library reliably grows "dragon",
  "Dragon" and "dragons" meaning the same thing.
- **Collections** — nestable, because a Kickstarter pledge is genuinely a
  collection of collections. A model can be in as many as you like, and
  deleting one never touches the models or the collections inside it.
- **Liked** — a private per-user list. Press the heart on any model.

Counts everywhere exclude models missing from disk: a creator page promising
forty models when eight are on an unplugged drive sends you looking for
something that is not there.

## Removing models

Two different things share the word "delete", so they are two buttons:

- **Remove from library** forgets the model and leaves every file where it is.
  A scan will not bring it back — the removal is recorded — and it can be undone
  from Manage → Libraries. This is the only option for a library pointed at
  folders you already had.
- **Delete the files** actually erases them, and appears only for a library this
  app owns and writes to. It asks you to type the model's name, because it is
  the one irreversible action in the application.

Restoring rebuilds the model from the files and its sidecar at the next scan, so
notes and tags come back only if they were written to one.

## Library health

`/admin/health` reports nine kinds of problem — missing files, empty folders,
duplicate bytes, unreadable meshes, models nested inside other models, and
metadata gaps. Every detector clears its own problems: fix the thing and it
disappears at the next pass, which runs after every scan and again overnight.
Anything you do not care about can be ignored in bulk without pretending it
was fixed.

## Sharing

A model can be shared by link. The token is separate from the internal id, so
revoking it actually revokes something, and a shared link grants exactly one
model — not the library, not search. Sharing is off instance-wide by default;
turning it off closes every existing link at once.

## Backup and restore

See [docs/deployment.md](docs/deployment.md). In short: your files are never
modified so back them up as you already do, `pg_dump` covers the database, and

```bash
npm run backup export backup.json
npm run backup import backup.json -- --dry-run
```

writes a readable metadata export that restores into a rebuilt database by
matching paths rather than ids. The sidecars are the real safety net — drop the
database, migrate, rescan, and metadata comes back from disk.

## Contributing

Bug reports and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md)
covers setup, the checks CI runs, and the handful of invariants worth knowing
before changing them.

One thing to read first: the rule in
CONTRIBUTING about `.env` — without one, the database-backed third of the test
suite skips silently and a green run proves much less than it appears to.

Security vulnerabilities go through [SECURITY.md](SECURITY.md), privately,
rather than the issue tracker.

## License

[MIT](LICENSE) — © 2026 Owl Media.
