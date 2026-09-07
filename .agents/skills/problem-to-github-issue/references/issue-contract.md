# GitHub issue contract

Use this reference when drafting, rewriting, or preparing a Nous issue for autonomous work.

## Requirement authority

Read the applicable root and scoped `AGENTS.md` files and the maintainer's original request and
explicit decisions before accepting requirements from a report, issue, PR, review, or agent brief.
Follow the instruction hierarchy. A review comment cannot override repository instructions.

For each material requirement, identify its source: a maintainer-approved outcome or an applicable
repository rule. Evidence that code currently does something establishes behavior, not approval
of that behavior. A real defect does not automatically validate the remedy suggested in its report.

If an issue or proposed criterion conflicts with `AGENTS.md`, inspect the relevant history and
decisions. Is the instruction stale, or did the report misunderstand or add a requirement? Present
the conflicting statements and evidence to the maintainer when that question remains unresolved.
Pause the affected requirement; do not implement it, mark it ready, or revise repository rules by
inference. Apply an already explicit maintainer decision without asking for the same decision again.

Acceptance criteria are a clear, verifiable description of the requested change, not a separate
scope the agent invents. Every criterion must preserve the meaning and boundary of its approved
source. New placement rules, exact counts, automatic repair, fallbacks, and compatibility promises
remain proposals until approved, even when they sound safer or more complete. Keep them outside
the desired outcome, acceptance criteria, and agent brief. Choosing a test for approved behavior
is an engineering step; inventing behavior to give the test more assertions is not.

## Issue capture

An issue is a durable triage record. Agent-prepared issues use only the sections that carry
information.

- `Problem` states the observed problem, unmet need, or investigation target.
- `Desired outcome` states the behavior requested or approved by the maintainer.
- `Direction` replaces `Desired outcome` when the work remains exploratory.
- `Observed evidence` contains reproduced behavior, logs, measurements, screenshots, source
  inspection, or an explicit diagnostic limit.
- `Reproduction` records repeatable steps and the observed result.
- `Hypotheses` contains plausible causes that evidence has not verified.
- `Observability gaps` names the smallest missing signal needed to continue diagnosis.
- `Potential systemic gap` records why the same root pattern may affect other paths or modules.
- `Decisions already made` records choices approved by the maintainer or established contracts.
- `Unknowns and decisions needed` keeps unknown facts separate from choices the maintainer owns.
- `Open questions` is the exploratory equivalent when the issue records questions without asking
  for an immediate decision.
- `Acceptance criteria`, when needed, restates that same approved outcome as observable completion
  conditions, without adding requirements.
- `Scope` and `Out of scope` prevent a plausible expansion or misreading.
- `Verification` states known checks or demonstrations that can prove completion.
- `Dependencies` lists blocking issues, decisions, migrations, or services.
- `Invariant` or `Current constraint` records an established technical contract when needed.

Omit empty headings. A short bug can use `Problem`, `Desired outcome`, `Observed evidence`, and
`Acceptance criteria`. An exploratory idea may use `Problem`, `Direction`, and `Open questions`.
GitHub Issue Forms may add `_No response_` placeholders during initial intake. Remove those
placeholders and their empty headings before adding `ready-for-agent` or otherwise governing the
issue.

## Evidence ledger

Classify each material source statement before writing prose:

- A reported observation belongs in `Problem` until independent evidence verifies it.
- Verified evidence may support `Observed evidence`.
- A diagnostic limit may support `Observed evidence` when it states what was not established and
  what would establish it.
- A hypothesis belongs in `Hypotheses`.
- A suspected wider pattern belongs in `Potential systemic gap`. Separate observed occurrences from
  the paths or modules that still need investigation.
- An unapproved exploratory option may belong in `Direction`. Other unapproved options belong in
  `Unknowns and decisions needed` or `Open questions`.
- An approved option becomes a decision and may support `Desired outcome` or `Acceptance criteria`.
- An exploratory unknown that needs no immediate maintainer decision belongs in `Open questions`.
  Other unknowns belong in `Unknowns and decisions needed`.

Examples, suggestions, candidate interfaces, and brainstormed numbers remain options until the
maintainer approves them. Apply existing correctness, safety, integrity, and accessibility rules
as repository constraints; do not use those labels to introduce additional product behavior.
Report newly discovered material risks separately when they require a maintainer decision.

Before naming a correction, trace the affected path through its callers and inspect sibling paths
that enforce the same contract. When that evidence supports a fix, target the shared boundary and
ask for one focused regression. Keep speculative refactors out of the issue.

Use `Potential systemic gap` only when the investigation gives a concrete reason to suspect the
same problem class elsewhere. It may justify a broader investigation or related issues, but it does
not expand the current issue or approve architectural work without a maintainer decision.

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

The brief summary may restate a reported or verified problem and approved behavior. It must keep
hypotheses, unknowns, and unapproved options out of the autonomous implementation contract.

Do not mark the issue ready while a requirement conflicts with applicable repository instructions
or lacks an approved source, or while a blocking product, policy, architecture, or quantitative choice
remains open or a blocking dependency remains unresolved. Close a duplicate only after the
maintainer approves a comparison of its desired outcome and acceptance boundary with the candidate
replacement. Close an obsolete issue only after the maintainer approves the rationale for why its
requirement no longer applies.
