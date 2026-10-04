# Model metadata and model site imports

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
are not guessed into public MakerWorld URLs. For a newly indexed project with a
MakerWorld `DesignModelId`, the worker makes bounded public metadata requests:
it resolves the internal identifier through Bambu Cloud's model mapping endpoint,
then checks that the public design has the same internal identifier before
adding its tags, description, creator, license and source link. No cookie or
remote model download is needed for this enrichment. Its sharpest usable embedded cover remains
preferred. If the source is unavailable, private, changed, or rate limited, the
local package's metadata is still imported and geometry processing continues.
Projects without this recognized identifier remain entirely local.

Model cards describe the printable file format, even when the selected artwork is
a WEBP or another image. Detail and shared pages default to the thumbnail and offer **Thumbnail** and
**3D model** controls when both previews exist. Embedded cover selection prefers
higher resolution artwork over small thumbnails and plate renders. Switching retains the loaded model and camera
while pausing rendering when the thumbnail is displayed.

## Importing a MakerWorld link

In **Account settings → MakerWorld**, save your own MakerWorld token cookie
(or a Cookie header containing `token=...`). This personal settings page is
available from the navigation and account menu to users who can upload. Then
on **Upload**, choose a writable library and paste a MakerWorld model-page URL.
A `#profileId-...` fragment selects that published print profile. Without a
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
Model downloads are limited to 512 MiB per file, with at most 20 supported files
per import. Optional remote artwork is limited to 16 MiB and 16 megapixels;
embedded artwork remains limited to 4 MiB. Raster previews preserve source
resolution up to 2048 pixels without enlarging smaller images.

## Importing Printables and Thingiverse links

On **Upload**, paste a MakerWorld, Printables, or Thingiverse model-page URL into
the same import form and choose a writable library. PrintBench detects the
provider from the URL. Upload shows connection status and links to the relevant
account settings; credentials are entered only in settings.

Public free Printables models do not require a saved cookie or API token.
Paid or private content is not supported by this importer.

For Thingiverse, open **Account settings → Thingiverse** and save your own App
Token/access token. PrintBench does not use the Client ID or Client Secret and
does not perform an OAuth browser login or callback. [Thingiverse's developer documentation](https://www.thingiverse.com/developers)
explains creating an app and obtaining API access. The token field is masked;
after saving, only its saved status is displayed. **Remove API token** removes
the connection for your own PrintBench account.

Then paste a `https://www.thingiverse.com/thing:…` model URL on **Upload**.
Printables model URLs use `https://www.printables.com/model/…`. The form follows
background import progress and links to the indexed model when complete. Imports
bring in the title, creator, description, tags, license, cover, source link, and
supported STL/3MF/OBJ/PLY files. Original filenames are preserved with a source
file ID prefix to avoid collisions.

Printables uses its public website GraphQL endpoint, which is not a documented
stable API contract. Thingiverse uses its documented authenticated API. Requests
are restricted to each provider's API and documented download/image hosts;
credentials are never forwarded to CDN hosts. Removing one provider's credentials
preserves the other connection.

A local Printables or Thingiverse file cannot be identified from its filename
alone. Generic embedded 3MF metadata still imports, but website metadata requires
a model-page link. This importer does not guess a source or search by filename.

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
