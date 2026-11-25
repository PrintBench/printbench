---
name: printbench-release
description: Audit, prepare, cut, or verify a PrintBench version release across the app, docs changelog, and website roadmap. Use for release readiness, release PRs, or checking a published tag.
---

# Release PrintBench

Use the [app release checklist](../../../docs/releasing.md) for versioning, preflight, assets, and recovery. Read the READMEs in `printbench-docs` and `printbench-website` for docs sync and roadmap rules. Locate the three checkouts by their PrintBench Git remotes. They are usually siblings in the PrintBench HQ workspace, but an app worktree may be elsewhere. Establish the target version and candidate ref from the request or current release PR, and flag any ambiguity that changes what would ship.

## Establish the release scope

- Compare the candidate commit with the previous published release tag in the relevant release line. Use published GitHub release information to establish the baseline, and name both the baseline and candidate in the report. Treat any fallback to locally available refs as provisional.
- Use the commit range to identify what will ship, including direct commits and changes bundled in a release PR. Use GitHub PR reviews and checks to confirm approved candidates. Account for intended PRs absent from the candidate and unexpected changes present in it. Flag uncertain PR attribution or review status.
- For each included change, inspect the diff and record its documentation impact. Point to the affected guide, reference, or upgrade page, link any companion docs PR and give its status, or explain briefly why no docs change is needed. Check the linked changes and any existing release notes against the actual behavior, especially new settings, migrations, permissions, and deployment or upgrade changes. Flag gaps even for PRs that are already approved.

For a readiness audit or verification-only request, gather evidence and report gaps without editing release files. For a read-only docs drift check, run `node scripts/sync.mjs --check --source <app-checkout>` from the docs checkout. For preparation, draft or update the release changes below. Reuse existing release PRs when authorized to update them.

## Prepare the app, docs, and website

1. **App.** Follow the release checklist for the version bump, lockfile, and bundled filament catalogue. Write the canonical `docs/releases/v<version>.md` with user-facing highlights and a nonempty `## Upgrade notes` section. Cover operator actions or say that none are needed. GitHub Releases and the docs changelog both use this note.
2. **Docs.** Update the relevant handwritten pages in `printbench-docs`. Run `npm run docs:sync -- --source <app-checkout>` to generate the changelog entry, index, and navigation from the prepared app checkout. Check the source working tree before syncing so unrelated local changes do not enter the generated pages. Run `npm run docs:check -- --source <app-checkout>` and review the generated diff. Land the app preparation on `main` before landing the synced docs PR, because docs CI compares against app `main`.
3. **Website.** Inspect `printbench-website/src/content/roadmap/` for entries covered by the release. Check descriptions against the behavior that will ship. Update the existing entry where possible, with `status: shipped` and the release `version`, and preserve the correct first shipped version on historical entries. Leave partially delivered items at their current status unless the release warrants changing their scope. For prereleases, leave the stable roadmap unchanged by default. Record when no roadmap items change. Validate changes with `npm run build` and prepare them for publication once the corresponding release and release-notes link are live.

## Check readiness and publish

- Use a checkout of the exact candidate SHA for final app preflight and as the source for the final docs sync check. Run the app preflight from the runbook, including `npm run release:check -- v<version>`, and confirm CI for the prepared app commit. Confirm required docs changes have landed and docs CI passed. Review the website build and track applicable roadmap updates for after publication. Report any skipped or failed checks with the reason.
- Report the version, exact candidate SHA, included PRs and any scope discrepancies, documentation coverage, companion PRs or diffs, and outstanding work. Distinguish blockers to tagging from planned post-release tasks.
- Pushing a version tag triggers the existing GitHub Actions release workflow. Push only when a maintainer has authorized publication of the specific version and prepared commit. Before pushing, confirm against the upstream app repository that the commit is on `main`, the required checks passed for that commit, and the tag is unused locally and upstream. If the candidate changes, reassess it before proceeding. Never move or reuse a published tag. Use the runbook for partial failures and retries.

## Verify the published release

Follow the release workflow through completion and confirm it succeeded for the expected tag and SHA. Follow the runbook's checks for the GitHub release body, prerelease status, container images, and release assets. Verify the deployed docs release index and version page. Once the release and notes are live, land the applicable website update if authorized. Verify the deployed roadmap, including its version links. Report the public URLs and any remaining deployment or verification failures.
