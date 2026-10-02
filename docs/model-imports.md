# Model metadata and MakerWorld imports

## Uploading a 3MF

Newly indexed 3MF files can supply a title, designer, description, license,
source-file creation/modification dates, and an embedded thumbnail. The worker
reads standard 3MF metadata and Bambu Studio's designer fields from the package's
main model part. It uses OPC thumbnail relationships, with common slicer thumbnail
paths as a fallback. Source-file dates are shown in notes; they are not the date
of upload to PrintBench or proof of publication on a website.

Metadata fills empty fields once. A scanner-generated model name may become the
embedded title; an explicitly edited model name keeps its name. Existing database
records, edits (including deliberately cleared fields), and sidecar metadata take
precedence. For a folder containing several 3MF files, the first live 3MF by
lexicographic relative path supplies metadata. Later files do not replace it.
Existing records are protected by the migration and are not automatically
backfilled. Re-upload into a new model to apply the new extraction behavior.

The source file is never modified. Missing, malformed, oversized, ZIP64, or
unsupported metadata falls back to the existing geometry analysis/rendering
pipeline. Selected ZIP entries have compressed/uncompressed size limits, and
embedded images have byte/pixel limits. Geometry entries are not decompressed by
the metadata reader.

A 3MF is not guaranteed to contain tags, a public model URL, or all the metadata
on its download page. Internal Bambu identifiers are retained by the parser but
are not guessed into public MakerWorld URLs. Local uploads do not contact
MakerWorld automatically.

## Importing a MakerWorld link

On **Upload**, choose a writable library, save your own MakerWorld token cookie
(or a Cookie header containing `token=...`), and paste a MakerWorld model-page
URL. A `#profileId-...` fragment selects that published print profile. Without a
fragment, the first published profile is imported.

The worker fetches the model's title, creator, description, tags, license, source
link, artwork, and selected 3MF. Downloaded files go into a dedicated model folder
and are indexed through the normal scanner. Source links and metadata are written
to PrintBench sidecars when the library allows sidecar writes. Repeating the same
link in the same library follows the existing import; failed imports can be
retried. Files in an existing model are never overwritten by an import.

Sessions are per user, encrypted with PrintBench's existing secret-box mechanism,
and never returned to the browser after saving. Queue payloads contain only an
import ID. Removing the cookie or changing permissions takes effect before a
queued import starts. Session expiry, access refusals, rate limits, unsupported
responses, and storage/scan failures appear as controlled errors. There is no
browser challenge bypass or automatic cookie extraction.

MakerWorld does not provide a supported public API contract for these endpoints.
This provider uses Bambu Cloud endpoints and may need maintenance if their
response or authentication requirements change. Public metadata is available
without a session; resolving download links requires one. Network requests are
restricted to the API host and known download hosts, use HTTPS and public DNS
addresses, reject redirects, and do not forward the session to download hosts.
3MF downloads are limited to 512 MiB; optional artwork to 4 MiB.

## Verification

Run the required lint, TypeScript, and complete database-backed test suite from
CONTRIBUTING.md. New tests cover bounded archive/image parsing, metadata authority
and persistence, provider/network failures, credential and action boundaries,
download staging, retries, and duplicate delivery.

With the web and worker running, `npx tsx scripts/verify-model-imports.mts` exercises
a real resumable upload and its metadata, thumbnail, search, and sidecar results.
The synthetic fixture is created at runtime. It does not require a MakerWorld
session and does not prove authenticated MakerWorld downloads; check one owned
session import through the browser before deploying that provider.
