## Sonar merge decision

Check exactly one:

- [ ] Sonar required: `bun run gate:full` passed on the exact commit proposed for merge, with coverage completed before the local Sonar scan.
- [ ] Narrow skip: this is a trivially scoped docs/metadata/workflow-only change with no analyzable application-code or runtime-behavior change, CI/review are clean, and no reviewer or CI signal requests Sonar.

If Sonar was required but unavailable, I started the existing local service with `bun run sonar:up`, ran `bun run sonar:bootstrap` when required, and reran the full gate. Every new Sonar finding was fixed or explicitly resolved with an owner-visible disposition.

Sonar result or skip rationale:

<!-- A green CI result does not replace required local Sonar evidence. A skip must explain why every narrow-skip condition is satisfied. -->

## Summary

<!-- What changed and why? -->

## Testing

<!-- List the relevant checks and their results. -->
