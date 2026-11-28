# Deploying PrintBench

Postgres is the only infrastructure dependency. There is no Redis, no message
broker and nothing to compile — which is the whole point of the project.

Two processes run from one image:

| Process  | What it does                                                                 |
| -------- | ---------------------------------------------------------------------------- |
| `web`    | Next.js. Pages, auth, the thin API layer. Never does heavy I/O.              |
| `worker` | Scanning, mesh analysis, thumbnails, uploads, ZIP streaming, scheduled jobs. |

An `nginx` container sits in front, serving large files with `sendfile` so
multi-gigabyte downloads never pass through Node.

---

## Quick start on this computer

With Docker and Compose installed, download
[compose.yaml](https://github.com/PrintBench/printbench/releases/latest/download/compose.yaml)
into an empty folder. Open a terminal in that folder and run this command.

```bash
docker compose up -d
```

Docker pulls the public release images anonymously. Open <http://localhost:8080>
and create your admin account. Create a library for
uploads and add your first model. To index an existing folder, set `LIBRARY_PATH`
in a `.env` file next to `compose.yaml`, run `docker compose up -d` again, and
select `/libraries` in the library setup. The existing folder is mounted read-only.
Set `PRINTBENCH_PORT` in the same file if port 8080 is in use, and open the new port.

The quick start listens on localhost. It generates the PostgreSQL password and
auth secret once and stores them in the `credentials` volume. Keep that volume
with the `pgdata` and `data` volumes when backing up Docker volumes. Use
`docker compose down` to stop and remove the containers while keeping the volumes.

To upgrade, back up the instance, replace `compose.yaml` with the asset from the
new release, and run `docker compose up -d` from the same folder. The Compose
file selects the matching application and nginx versions. If you already have a
deployment, keep using its Compose files and follow its normal upgrade procedure.

You can also [build PrintBench from source](#docker-compose-from-source).

## Docker Compose from source

```bash
cp .env.example .env
```

Set these before starting anything:

| Variable             | What it is                                               |
| -------------------- | -------------------------------------------------------- |
| `POSTGRES_PASSWORD`  | Anything long. It never leaves the compose network.      |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32`. **See the warning below.**    |
| `APP_URL`            | The address people will actually type, including scheme. |
| `BETTER_AUTH_URL`    | The same value.                                          |
| `LIBRARY_PATH`       | Host folder holding your print files. Mounted read-only. |

Existing collections are read-only by default. Set `LIBRARY_READ_ONLY=false`
to allow the web and worker services to write metadata sidecars; nginx always
mounts the collection read-only. This replaces `LIBRARY_MODE`: migrate `rw` to
`LIBRARY_READ_ONLY=false`, or `ro` to `LIBRARY_READ_ONLY=true`.

The compose file also sets two variables you only need to touch if you change
the mounts:

| Variable        | What it is                                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LIBRARY_ROOTS` | Where an admin may point a library. Confines the folder picker, so browsing cannot wander outside what is mounted.                                                     |
| `ACCEL_MOUNTS`  | Maps nginx's internal locations to filesystem roots. **Must match `docker/nginx.conf`** — a mismatch shows up as downloads 404ing while the app thinks they succeeded. |

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
```

The first run applies migrations and starts at `/setup`, which creates the
first admin account. That page stops working the moment a user exists.

> **`BETTER_AUTH_SECRET` is not just a session key.** It also derives the
> encryption key for stored printer API keys, and it signs the short-lived
> links used for slicer hand-off, uploads and ZIP downloads. Changing it signs
> everyone out _and_ makes stored printer credentials unreadable — they will
> need re-entering. Back it up with your database.

---

## Coolify

Coolify runs the repository's `docker-compose.yml`. Two things to know.

The library mounts use long YAML syntax so Coolify can parse the host path and
read-only setting independently. If an older 0.5.0 compose file fails with
`Invalid volume source: contains forbidden character '${'`, replace the
short library mount entries with the long-form entries in the current compose
file. Changing `LIBRARY_PATH` in Environment Variables alone does not fix the
parser error. Keep the same host path and persistent volumes when redeploying.

### Let Coolify terminate TLS

Coolify's Traefik handles certificates and proxies to the `nginx` service in
this stack. Do not add a second TLS layer.

1. **New Resource → Docker Compose**, pointed at this repository.
2. Set the domain on the **`nginx`** service. Because nginx listens on
   container port **80**, the domain should usually be just
   `https://prints.example.com` with no port suffix. Not on `web` —
   `web` does not serve files, and pointing at it directly loses the
   `X-Accel-Redirect` hand-off that keeps large downloads off the Node event
   loop.
3. Add the environment variables above under **Environment Variables**.
   `APP_URL` and `BETTER_AUTH_URL` must be the public `https://` address, or
   share links and slicer hand-off will be built with the wrong host.

### Storage must be a persistent volume

In Coolify's **Storages** tab, mount:

| Path in container     | Holds                                               | If you lose it                                 |
| --------------------- | --------------------------------------------------- | ---------------------------------------------- |
| `/data/library`       | Your model files (or bind-mount an existing folder) | The models themselves                          |
| `/data/previews`      | Generated thumbnails                                | Nothing — regenerated by a scan                |
| `/var/lib/postgresql` | The database                                        | Metadata, unless you have sidecars or a backup |

Postgres 18 changed where the data directory lives. Mount
`/var/lib/postgresql`, **not** `/var/lib/postgresql/data` — the container
refuses to start with the older convention.

### Network storage

A NAS share is just a path. Mount it on the host and point `LIBRARY_PATH` at
it; nothing in the application knows the difference.

For SMB, mount with `nobrl` if you see sporadic locking errors, and prefer
`vers=3.0` or later. Note that a scan reads directory timestamps, which some
SMB configurations do not update reliably — if scheduled scans miss changes,
run a deep scan (which re-stats every file) on a weekly schedule instead.

**If the share is unmounted, the library root disappears and every model looks
missing.** The scan refuses to act on this: it aborts if the root is
unreadable, if it is empty while the database knows of models, or if more than
20% of models would be marked missing. The nightly prune additionally skips any
library where _every_ model is missing. You have to remount and rescan; nothing
is deleted in the meantime.

---

## Two kinds of library

The distinction matters and the UI now asks it in plain language, but for the
record:

- **Files I already have** (`in_place`) — indexed where they sit, never moved,
  renamed or deleted. `LIBRARY_PATH` is mounted read-only precisely so this
  promise cannot be broken by a bug.
- **Somewhere to upload to** (`managed`) — a folder the app owns and writes
  into, which is what makes the Upload page work. Created under
  `MANAGED_LIBRARY_ROOT` (default `<DATA_DIR>/libraries`) on the writable data
  volume, because the collection mount deliberately is not writable.

You need at least one of the second kind before anything can be uploaded
through the browser.

## S3 and S3-compatible storage

Set the library's backend to `s3` and supply bucket, region, and credentials.
MinIO, Backblaze B2 and Wasabi all work — set the endpoint and leave path-style
addressing on, which is the default whenever an endpoint is set.

A bucket can be either kind of library: one you already have files in, which
stays read-only like any other in-place library, or one this application
uploads into.

Downloads from an S3 library are served as presigned redirects, so the bytes go
straight from the bucket to the browser and never enter this application at
all. Uploads go the other way as a multipart upload, so peak memory is the
in-flight window (8 MB parts, four at a time) rather than the size of the file
— a 6 GB mesh uploads in roughly the same memory as a 6 MB one.

Three differences worth knowing:

- **There are no empty folders.** A key is a string; a folder only exists
  because objects share a prefix. A scan of an S3 library therefore never
  reports an empty model folder.
- **Change detection uses ETags, not timestamps**, because `LastModified`
  changes whenever an object is rewritten even if the bytes are identical.
- **Live watching is not available.** There is no filesystem to watch, so an
  S3 library relies on its scan schedule, or on the scan that is triggered
  automatically after an upload.

Nothing has to be enabled or deployed for this: the bucket, an IAM policy
scoped to it, and a CORS rule (needed only by the 3D viewer, not by downloads)
are the whole of the setup. **[docs/s3-storage.md](s3-storage.md)** has the
policy JSON, the CORS rule, per-provider endpoints, `npm run verify:s3`, and
what each error message means.

---

## Backups

### The whole instance, from the UI

**Manage → Backup** downloads one `.pbbackup` file holding everything the
instance knows: accounts, libraries, models, tags, collections, print history,
printers, settings and the audit trail. Restoring it makes another PrintBench a
copy of this one.

Two choices when you download:

- **Include uploaded files** adds the model files from libraries PrintBench
  stores uploads in. Folders you pointed PrintBench at, and S3 libraries, are
  never copied — they are yours, and they are already somewhere.
- **A passphrase** carries printer keys, S3 secrets and import sign-ins across,
  re-encrypted so that the new instance does not need the old
  `BETTER_AUTH_SECRET`. Without one they are left out and re-entered afterwards.

Thumbnails are not in the file; they are re-rendered after a restore. Signed-in
sessions and application logs are not either.

The file is not encrypted as a whole. It holds email addresses and password
hashes, so keep it as carefully as you would a database dump.

To restore:

- **On a new server**, open it for the first time and choose _Restore from a
  backup_ on the setup screen. There is nothing to replace, and you sign in
  with an account from the backup.
- **Over an existing instance**, use Manage → Backup → Restore. This replaces
  everything and signs everyone out. It either completes or changes nothing:
  the database is rebuilt in a single transaction.

A backup restores into the same or a newer PrintBench, never an older one. If
your existing folders are mounted at a different path on the new server, their
models show as missing until the mount matches; nothing is deleted meanwhile.

### Scheduled backups to S3

**Manage → Backup → Scheduled backups** writes the same backup to one of your S3
connections on a schedule (daily, weekly, twice a day, or a cron of your own, in
the server's time zone), keeping the newest N. Library files are never
included; photos and stored credentials always are. The bucket needs a prefix of
its own (no library may index it) and a key that can write and delete there; see
[S3 storage](s3-storage.md#scheduled-backups).

Every scheduled backup is **encrypted as a whole**, email addresses and password
hashes included. You choose a passphrase when you set it up, and PrintBench keeps
only a key sealed under it:

- The server can write backups but cannot read them. Someone who takes the
  running server, its database and its `BETTER_AUTH_SECRET` still cannot open
  the backups already in the bucket.
- Restoring needs the backup file and the passphrase, and nothing else: not the
  old server and not its `BETTER_AUTH_SECRET`.
- **The passphrase cannot be recovered.** Lose it and the backups are
  unreadable. Use _Check your passphrase_ now and then, while there is still
  time to change it.
- Changing the passphrase makes a new key. Backups from then on need the new
  one; older backups still need the old one, and the list marks them.

Each instance writes into a folder of its own under the prefix:
`<prefix>/<instance id>/printbench-<time>.encrypted.pbbackup`. The instance id
belongs to the server, not the data. It is not in backups, and a restore keeps
the id of the server it restores onto. So restoring onto the same server
carries on in the same folder, and a new server restored from an old one
starts a folder of its own. Two servers pointed at the same prefix never share
a folder.

Pruning only ever looks in the instance's own folder, deletes only files with
that name, and runs only after a new backup has been written and seen in the
bucket. A failing bucket never costs you the backups already in it, and no
instance can delete another's.

To restore one:

- **On this instance**, the backups in the bucket are listed under the schedule:
  this instance's first, then any from other instances' folders under the same
  prefix (the server this one replaced, say). Choose _Restore…_, enter the
  passphrase, check what it holds, and confirm.
- **On a new server**, open _Restore from a backup_ on the first-run setup
  screen and choose _An S3 bucket_. Enter the bucket, its endpoint (blank for
  AWS) and region, an access key that can read it, and the prefix the old
  server's schedule used (`printbench-backups` unless you changed it). _List
  backups_ shows every backup under that prefix, from every instance folder,
  newest first, with the date and version each was taken by. Choose one, enter
  its passphrase, check what it holds, and restore. These bucket details are
  used for that one restore and are not saved: the restored database brings
  the old server's S3 connection back with it. Like the rest of first-run
  setup, this closes the moment any account exists. The schedule comes back
  with the rest of the settings, so backups carry on from the new server, into
  its own folder.

  You can still copy the file out of the bucket with any S3 tool and upload it
  under _A backup file_ instead; it asks for the passphrase the same way.

Both use the same restore as a downloaded file. A backup being restored is
staged in `DATA_DIR/backups`, decrypted once its passphrase is given. Nothing
staged is left behind: cancelling, closing the panel or leaving the page
deletes it at once, a failed restore deletes it, and anything a closed tab
abandoned is deleted after an hour untouched. This applies to uploaded
backups as well as ones fetched from the bucket.

The rest of this section is the manual equivalents.

Three things can be backed up, and they are not equally important.

### 1. Your model files

Not our problem, and deliberately so — the application never modifies them.
Back them up however you already back up files.

### 2. The database

Everything you typed: tags, creators, licences, collections, print history,
accounts.

```bash
docker compose exec db pg_dump -U printbench printbench > backup.sql
```

Restore into an empty database:

```bash
docker compose exec -T db psql -U printbench printbench < backup.sql
```

### 3. The metadata export

A readable JSON file, independent of the Postgres version, that survives a
schema change:

```bash
npx tsx scripts/backup.mts export backup.json
```

Restoring matches models by `(library path, model path)` rather than by id, so
it works against a rebuilt database whose ids are all different — which is
exactly the situation you are in when you need it:

```bash
npx tsx scripts/backup.mts import backup.json --dry-run   # report only
npx tsx scripts/backup.mts import backup.json
```

Scan your libraries **first** so the models exist, then import. The importer
only fills blanks; it never overwrites metadata you have entered since the
export.

Thumbnails and model files are not in the export. Thumbnails are regenerated by
a scan, and the files are already on disk.

### The sidecar, which is the real safety net

With `writeSidecars` on (the default), a `.printbench.json` is written beside
each model in a writable library holding its tags, creator, notes, licence
details, and source or additional links. The database can then be rebuilt from
disk alone: drop it, migrate, rescan, and
the metadata comes back. There is a test that performs exactly that drill.

It is worth doing once yourself, on purpose, before you need it.

---

## Upgrading

```bash
docker compose pull && docker compose up -d
```

Migrations run automatically at startup, before the app accepts traffic. They
are forward-only — take a database backup before a major version bump.

### Knowing when to upgrade

**System settings → Updates** shows the version this instance runs and whether a
newer one has been released, with a **Check now** button. When a newer release
exists, admins also see a notice in the corner of the screen, next to the usual
scan and processing activity; dismissing it stays dismissed until the next
release.

The check reads one public, unauthenticated URL
(`api.github.com/repos/PrintBench/printbench/releases/latest`) at most every six
hours, and sends nothing about the instance, its library or its users — not even
the installed version. Prereleases and drafts are ignored, and a version string
PrintBench cannot parse (a fork, or a local build) is never reported as out of
date.

Turn **Check for new versions** off if the instance must make no outbound
requests at all. Nothing else in the app depends on it.

---

## Health and troubleshooting

`/api/health` returns the process status and is what the container healthcheck
uses.

**Scanning does nothing.** Check the library has scanning enabled and a
schedule (Manage → Libraries). Scheduled scans are fast scans, which trust
directory timestamps; run a deep scan by hand if files were edited in place.

**Thumbnails never appear.** The worker renders them. Check its logs; a
reconcile sweep re-enqueues anything left pending every 15 minutes, so a
missing thumbnail should heal itself within that window.

**A scan aborted.** That is deliberate. Look at Manage → Libraries for the
reason. `mass_disappearance` means more than 20% of models vanished at once,
which is nearly always an unmounted drive rather than a deletion.

**Everything is marked missing.** The library root was unreadable at scan time.
Remount and rescan. Nothing is deleted until the grace period expires, and the
prune refuses to touch a library where every model is missing.
