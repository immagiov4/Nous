---
name: problem-to-github-issue
description: Diagnose a reported Nous problem, capture a product idea or investigation, and create or rewrite an English GitHub issue without inventing requirements. Use before opening, editing, deduplicating, or preparing an issue for autonomous implementation.
---

# Turn evidence into a GitHub issue

An issue preserves the problem, verified evidence, and maintainer decisions. It may remain
exploratory. A separate agent brief makes settled work executable.

Read [the issue contract](references/issue-contract.md) before drafting or rewriting an issue.

## Investigate before drafting

1. Inspect accessible application state, logs, persisted records, source paths, and recent changes.
2. Reproduce the problem when practical. Record the smallest honest reproduction.
3. Trace the affected path through its callers and inspect sibling paths that enforce the same
   contract. Do this before proposing a fix.
4. Search open and closed issues for the same desired outcome and root-cause boundary.
5. Build an evidence ledger. Classify each material statement as verified evidence, a diagnostic
   limit, a hypothesis, an option, an unknown, or an approved decision.
6. Ask the maintainer when an unresolved choice would change product behavior, architecture,
   policy, or a quantitative limit.

When the evidence supports a correction, ask for one fix at the shared boundary and one focused
regression that exercises it. Do not prescribe a local patch or a refactor that the traced paths do
not justify.

Finish investigation when every material statement has a ledger classification and every
remaining limit names the evidence that would resolve it.

## Draft the issue

- Write the title and body in English.
- Use the smallest set of contract sections that carries the available information.
- Keep hypotheses and unapproved options out of desired behavior and acceptance criteria.
- Preserve missing evidence as a diagnostic limit. Do not fill the gap with a plausible cause.
- Describe observable behavior. Use code paths only as evidence, not as a brittle implementation
  plan.
- Keep unrelated warnings and adjacent improvement ideas out of the issue.

Before submitting, compare the draft with the evidence ledger. Every factual claim and requirement
must trace to its permitted source class.

## Respect the lifecycle

New issues start as triage records. Add a `ready-for-agent` label and an `Agent brief` only after the
maintainer approves that transition and all blocking decisions are settled.

The agent brief is the autonomous implementation contract. It describes behavior, boundaries,
dependencies, and verification. It does not silently answer open questions from the issue.

## Mutate GitHub only with authorization

Drafting and searching are read-only. Immediately before creating, editing, labeling, commenting
on, closing, or reopening an issue, confirm that the current request authorizes that mutation.

Use an authenticated GitHub connector or `gh` for private data and mutations. If neither is
available, return the draft and the exact blocked action. Do not substitute web search for private
repository access.

## Check the contract fixtures

Run:

```bash
bun run check:issue-skill
```

The check compiles fixture issue bodies from their Markdown sections and validates each statement
against its evidence ledger. It proves the contract at the draft boundary without pretending to
infer the meaning or language of arbitrary prose. Verify the English default from this skill and
the Issue Form during review.
