## What this changes

<!-- And why. The "why" is the part a reviewer cannot reconstruct from the diff. -->

## Checks

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm test` — **with the database up.** A run reporting skipped files did
      not exercise the database-backed third of the suite; see
      [CONTRIBUTING.md](../blob/main/CONTRIBUTING.md).
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

- [ ] No code was copied out of `reference/`.
