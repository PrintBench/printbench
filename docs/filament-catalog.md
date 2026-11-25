# Filament catalogue

PrintBench ships a filament catalogue built from the
[Open Filament Database](https://github.com/OpenFilamentCollective/open-filament-database)
(OFD). It covers brands, products, colours, spool sizes, print and drying settings, stores and buy
links. Users browse it at `/filaments/catalog` and use it to fill in the spool form.

## Never fetched at runtime

A self-hosted instance may have no internet access, so PrintBench never calls OFD while it runs.
The data is committed to this repository, ships inside the image, and the worker loads it into
Postgres. The only code that talks to OFD is the maintainer script below.

```
npm run filaments:update  (maintainer, online)
  └─ OFD GitHub release → verify sha256 → validate → normalise
     → packages/filament-catalog/data/*.ndjson, snapshot.json, logos.json, LICENSE-OFD
     → apps/web/public/filament-catalog/{brands,stores}/<uuid>.webp
worker boot (offline): filament-catalog.sync job → filament_catalog_* tables
web: reads Postgres only
```

## Refreshing the data

Before each release (see `docs/releasing.md`):

```bash
npm run filaments:update                              # latest OFD release
npm run filaments:update -- --tag dataset-v2026.11.23 # a specific one
```

The script:

- downloads the release's `all.json.gz` and checks it against the release manifest's sha256;
- validates it (`packages/filament-catalog/src/source-schema.ts`) and stops on a breaking upstream
  change rather than shipping data it half understands;
- writes one NDJSON file per entity, sorted, plus `snapshot.json` (source tag, dataset version,
  hashes, counts);
- downloads logos pinned to the same tag and re-encodes every one as WebP, SVG included, so
  untrusted upstream markup is never served from our origin. Unchanged source logos are not
  re-encoded (tracked in `logos.json`), so a refresh does not churn every image;
- prints an added/removed table to paste into the PR.

A run with no upstream change writes byte-identical files. Commit the result through a PR as usual.
`npm run release:check` warns when the snapshot is more than 30 days old and fails when it is
missing; the unit tests (`packages/filament-catalog/src/bundled-data.test.ts`) fail if the
committed files are inconsistent.

NDJSON rather than one compressed file is deliberate: one record per line delta-compresses in git,
so a refresh adds kilobytes of history rather than a fresh 3.4 MB blob, and the worker streams it
without holding the whole dataset in memory.

## Import

`syncFilamentCatalog` (`packages/core/src/services/filament-catalog-sync.ts`) is enqueued from the
worker's `startWork()`, so it runs at every boot and again after a restore. It is keyed on the
bundle's content hash: unless the bundle changed it reads one row and stops. A full import of the
current dataset takes a few seconds.

- **Keyed on OFD `uuid`, not `id`.** OFD's `id` is derived from the record's path and changes when
  a record moves; in ten weeks of releases thousands of sizes kept their `uuid` and changed `id`.
- **Nothing is deleted.** A row missing from the bundle gets `removed_at`. Owned filament may point
  at it, and records do come back upstream (which clears `removed_at`). Browsing and search hide
  removed rows; direct lookups return them flagged.
- **Unknown upstream fields are kept** in each row's `extra` jsonb, so new OFD fields survive
  until PrintBench models them.
- Purchase links are replaced wholesale; nothing links to them.
- One transaction under an advisory lock, so concurrent runs serialise and the loser no-ops.

The catalogue tables are excluded from backups (`apps/worker/src/backup/tables.ts`): they are
rebuilt from the running version's bundle after a restore.

## Owned filament

Choosing a catalogue colour in the spool form **copies** its values into the ordinary `filaments`
fields and records `filaments.catalog_variant_uuid` (and `filament_spools.catalog_size_uuid` for a
spool size). The copy is the user's to edit; the link is provenance. "Refresh from catalogue" on a
spool re-copies brand, material, colour and temperatures on request, keeping the user's name,
notes and diameter. Catalogue updates never change owned filament by themselves.

The link columns are deliberately not foreign keys: a filament backup must restore onto an
instance whose catalogue has not been imported yet, or no longer has the entry.

## Search

Variant-level `search_text` (brand, product, material if not already in the name, colour) is
written by the import, with a `pb_search` tsvector and a trigram index. Queries follow
`docs/search-notes.md`: full text, or `query <% search_text` for typos, unless the query uses
websearch operators.

## Licence

OFD data is MIT licensed. The upstream licence is committed beside the data as
`packages/filament-catalog/data/LICENSE-OFD`, and the catalogue pages credit the source and
dataset version. The data is community-maintained; the UI says so and links data sheets where
upstream has them.
