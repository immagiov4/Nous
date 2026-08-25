# GitHub issue contract

Use this reference when drafting, rewriting, or preparing a Nous issue for autonomous work.

## Issue capture

An issue is a durable triage record. Use only the sections that carry information.

- `Problem` states the observed problem, unmet need, or investigation target.
- `Desired outcome` states behavior the maintainer has chosen or the problem necessarily implies.
- `Direction` replaces `Desired outcome` when the work remains exploratory.
- `Observed evidence` contains reproduced behavior, logs, measurements, screenshots, source
  inspection, or an explicit diagnostic limit.
- `Reproduction` records repeatable steps and the observed result.
- `Hypotheses` contains plausible causes that evidence has not verified.
- `Observability gaps` names the smallest missing signal needed to continue diagnosis.
- `Decisions already made` records choices approved by the maintainer or established contracts.
- `Unknowns and decisions needed` keeps unknown facts separate from choices the maintainer owns.
- `Acceptance criteria` contains observable outcomes implied by approved behavior.
- `Scope` and `Out of scope` prevent a plausible expansion or misreading.
- `Verification` states known checks or demonstrations that can prove completion.
- `Dependencies` lists blocking issues, decisions, migrations, or services.
- `Invariant` or `Current constraint` records an established technical contract when needed.

Omit empty headings. A short bug can use `Problem`, `Desired outcome`, `Observed evidence`, and
`Acceptance criteria`. An exploratory idea may use `Problem`, `Direction`, and `Open questions`.

## Evidence ledger

Classify each material source statement before writing prose:

- Verified evidence may support `Observed evidence`.
- A diagnostic limit may support `Observed evidence` when it states what was not established and
  what would establish it.
- A hypothesis belongs in `Hypotheses`.
- An unapproved option belongs in `Unknowns and decisions needed` or `Open questions`.
- An approved option becomes a decision and may support `Desired outcome` or `Acceptance criteria`.
- An unknown belongs in `Unknowns and decisions needed`.

Examples, suggestions, candidate interfaces, and brainstormed numbers remain options until the
maintainer approves them. Ordinary correctness, safety, integrity, and accessibility consequences
may become acceptance criteria when the chosen behavior directly implies them.

Before naming a correction, trace the affected path through its callers and inspect sibling paths
that enforce the same contract. When that evidence supports a fix, target the shared boundary and
ask for one focused regression. Keep speculative refactors out of the issue.

## Ready-for-agent transition

The issue remains a triage record until the maintainer approves autonomous implementation. Mark
the transition with both:

1. the `ready-for-agent` label;
2. an `Agent brief` section appended to the issue body.

Use this shape:

```md
## Agent brief

### Category

### Summary

### Current behavior

### Desired behavior

### Key contracts and decisions

### Acceptance criteria

### Out of scope

### Dependencies

### Verification
```

Every heading in the brief must contain information. Remove irrelevant headings. The brief may
refer to issue evidence without copying volatile source locations into requirements.

Do not mark the issue ready while a blocking product, policy, architecture, or quantitative choice
remains open. Do not close an issue as duplicate or obsolete until the maintainer approves a
comparison of its desired outcome and acceptance boundary with the candidate replacement.
