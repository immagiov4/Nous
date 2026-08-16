## Merge gate evidence

- [ ] `bun run gate:full` passed on the exact commit proposed for merge.
- [ ] Coverage completed before the local Sonar scan, and the Sonar quality gate passed.
- [ ] Every new Sonar finding was fixed or explicitly resolved with an owner-visible disposition.
- [ ] If Sonar was unavailable, I started the existing local service with `bun run sonar:up`, ran `bun run sonar:bootstrap` when required, and reran the full gate.

Local Sonar result and command evidence:

<!-- CI does not run Sonar; a green CI result does not replace this evidence. -->

## Summary

<!-- What changed and why? -->

## Testing

<!-- List the relevant checks and their results. -->
