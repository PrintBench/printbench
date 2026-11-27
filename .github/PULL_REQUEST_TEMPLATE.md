## What this changes

<!-- And why. The "why" is the part a reviewer cannot reconstruct from the diff. -->

## Documentation impact

<!--
Link the documentation updated by this PR or the companion docs PR, and name the
affected pages. Include any upgrade or migration guidance readers will need.
If no documentation changes are needed, explain why.
-->

## Tests

<!--
For each new test: the scenario, bug or module contract it stands behind, and how
you saw it fail. "No new test" is a fine answer; say why. Reviewer's question:
would this fail if the thing a user does broke? See docs/testing.md.
-->

## Checks

- [ ] `npm run check` — formatting, lint, typechecking, release preparation tests
      and the full application suite, **with the
      development/test database configured, running and migrated**. This runs
      the full suite; see
      [CONTRIBUTING.md](https://github.com/PrintBench/printbench/blob/main/CONTRIBUTING.md).
- [ ] `npm run build`, if this affects builds.
- [ ] `npm run verify:smoke`, if this affects browser scan, upload or permissions.
- [ ] Relevant `npm run verify:phase*` script, if this touches that surface.
      Note these start their own job queue, so check the browser too if the
      change is queue-shaped.

## Anything a reviewer should know

<!--
Delete what does not apply:

- Migration included (generated with `npm run db:generate`, not hand-written)
- Golden render fixtures updated — say why the render legitimately changed
- New domain logic went in packages/, not a route handler
- Touches scan safety guards, path confinement, signed links or share tokens
-->
