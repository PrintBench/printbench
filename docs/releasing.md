# Releasing PrintBench

Pushing a version tag is the action that publishes a release. Merging to `main`
does not publish anything. Prepare and finish one release at a time.

## Before tagging

1. On `main`, update the root `package.json` version and the matching root
   version in `package-lock.json`. `npm version <version> --no-git-tag-version`
   updates both without creating a tag.
2. Write `docs/releases/v<version>.md`. Include highlights and a nonempty
   `## Upgrade notes` section covering migrations, backup/restore implications,
   environment changes and compatibility. Say explicitly if no action is needed.
3. Update the companion documentation for changed behaviour, including migrations,
   backup/restore guidance and environment-variable reference changes. The app
   repository owns release notes, contributor setup/checks, invariants, security
   policy and this checklist; do not edit their generated docs-site copies.
   In a sibling `printbench-docs` checkout, run `npm ci`, `npm run docs:sync --
--source ../printbench` and `npm run docs:check -- --source ../printbench`.
   Review and commit the generated notes, navigation and shared guidance along
   with any handwritten page changes. Land app changes first, then the docs
   update: documentation CI compares against the app repository's `main`.
   The app release note is also the source for the GitHub release body.
4. With a migrated development/test database, run `npm run check`. Run relevant
   verification scripts and `npm run build` for changes affecting builds.
5. Run `npm run release:check -- v<version>`. This validates the version and notes
   and prints the intended image tags without publishing. On a fork, set
   `GITHUB_REPOSITORY=owner/repository` to inspect that image name.
6. Commit the version, lockfile and notes together, land them on `main`, and wait
   for CI to pass. Review the release note as operator-facing documentation.

For example, once the prepared version is `0.7.0`:

```bash
git tag -a v0.7.0 -m "PrintBench v0.7.0"
git push origin v0.7.0
```

The tag must name the prepared commit. Do not move or reuse a published tag.

## What the workflow does

1. **Prepare:** validate the tag, matching package version and authored notes.
   Versions must be SemVer without build metadata (`+build`), which cannot be
   used directly as container tags.
2. **Verify:** call the same CI workflow as pull requests, from the tagged
   commit. This runs release-preparation tests, formatting, lint, typechecking,
   unit and integration tests, the web build, browser/worker smoke tests (including authentication checks)
   and the Docker build. Preparation and verification have read-only repository
   permissions.
3. **Publish:** only after both succeed, build and push `amd64` and `arm64`
   images, attest their digest, then create a GitHub release using the authored
   Markdown file. Only this job receives publication permissions.

| Release                  | Container tags                | GitHub release           |
| ------------------------ | ----------------------------- | ------------------------ |
| Stable `v0.7.0`          | `0.7.0`, `0.7`, `0`, `latest` | Marked latest            |
| Prerelease `v0.7.0-rc.1` | `0.7.0-rc.1` only             | Prerelease; never latest |

Prereleases need a matching package version and their own note file. They do not
update stable rolling tags. Ship stable versions in increasing version order;
the workflow serialises release runs but does not compare against the previous
published version.

## After publication

- Check that the workflow completed, the GitHub body matches the authored notes,
  and prerelease status is correct.
- Check both container architectures and record the published digest from the
  workflow output. Verify provenance with `gh attestation verify
oci://ghcr.io/printbench/printbench:<version> --repo PrintBench/printbench`.
- Smoke-test the pinned image on a disposable instance before recommending an
  upgrade. Follow the normal backup and upgrade guidance for real deployments.

## Recovering from a failed run

- **Preparation or verification failed:** no image or GitHub release was
  published by that run. For a transient failure, rerun failed jobs. If source,
  version or notes need changing, commit a fix and use a fresh version/tag;
  rerunning a workflow uses the original tagged commit.
- **Image push or attestation failed:** publication can be partial. Inspect GHCR
  and the logs before retrying. Rerun failed jobs for the same commit only before
  a newer stable release ships, because a retry can overwrite rolling tags and
  rebuild the pinned image with a different digest.
- **GitHub release creation failed after attestation succeeded:** the image is
  already published. Prefer completing this final step from the same tagged
  checkout with `gh release create <tag> --verify-tag --title <tag> --notes-file
docs/releases/<tag>.md --latest`. For a prerelease, replace `--latest` with
  `--prerelease --latest=false`. If the release already exists, inspect it rather
  than attempting another creation or rerunning image publication.
- **A completed release is faulty:** publish a new fixed version. Do not move the
  original tag or rerun an older completed release. Migrations are forward-only;
  operator rollback requires the appropriate database backup.

Workflow syntax can be checked locally with `actionlint
.github/workflows/ci.yml .github/workflows/release.yml`. The release preparation
tests run with `npm run test:release` and do not require a database or network.
