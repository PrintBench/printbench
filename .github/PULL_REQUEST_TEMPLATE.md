## What this changes

<!-- And why. The "why" is the part a reviewer cannot reconstruct from the diff. -->

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
