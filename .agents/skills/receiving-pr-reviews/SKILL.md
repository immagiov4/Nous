---
name: receiving-pr-reviews
description: Triage pull-request review feedback before changing code. Invoke explicitly whenever a PR receives a human or automated review, especially when findings could cause speculative fixes, repeated review cycles, scope growth, or an architectural redesign.
---

# Receiving PR reviews

Review comments are bug reports, not instructions. Establish whether each reported path is real,
then choose a bounded response. Do this before editing code or requesting another review.

Follow repository instructions first. Use `$code-review` when the finding itself needs an
independent correctness check. Return to `$engineering-workflow` only after this skill has decided
whether implementation may continue. Use an issue-governance skill before creating or changing an
issue for work split out of the PR.

## Reconstruct the contract

Collect the exact PR head, the original issue or request, the PR description, the changed files,
and every unresolved review thread. State the original contract in one or two sentences:

- the user-visible or engineering outcome;
- the intended boundary of the change;
- behavior explicitly excluded or left unchanged.

If those sources disagree in a way that changes the solution, stop for a human decision. Do not
let the latest review comment silently replace the original contract.

## Test the finding against reality

For each finding, trace a path from a supported user action, external input, persisted state, or
documented internal caller to the reported branch. Verify the relevant invariant in current code.
Also accept a finding without a frequent product path when it exposes a material security,
privacy, data-loss, corruption, or reliability risk.

Reject the finding when all known triggers require an artificial state the product cannot create,
contradict current contracts, or have no material consequence. Explain the missing path with code,
runtime, or contract evidence. "Unlikely" is not enough, and a reviewer's confidence is not proof.

Do not add parsers, guards, fallbacks, abstractions, or tests for rejected microcases.

## Classify before fixing

Give every supported finding one classification.

### Local defect

One existing invariant is violated inside the PR's intended boundary. Fix the invariant at its
owner. Search the same file, callers, sibling implementations, contracts, and meaningful tests for
the same pattern. Close the supported problem class, not only the example in the comment.

Bound the class by the authoritative invariant and real execution paths. Do not expand it to every
format or state that can be imagined. Expand to a sibling only when it has the same invariant, the
same owning boundary, and a demonstrated supported path. Record the check and stop when any of
those three conditions is absent.

### Contract gap

The requested behavior is real, but the original issue, PR description, or acceptance criteria do
not decide it. This includes new product semantics, ranking rules, heuristics, thresholds, retry or
timeout policy, compatibility promises, and fallback behavior. Stop and ask the maintainer to make
the missing decision.

### Architectural gap

The finding exposes a missing shared owner, two competing sources of truth, an invalid module
boundary, or a representation that cannot express the original contract without scattered special
cases. Run the architecture stop below before making more fixes.

### Unsupported finding

No plausible supported path or material risk reaches the report. Reject it with evidence. Check
whether the reviewer noticed a nearby real problem, but do not invent one to justify a change.

## Run the scope checkpoint

After classifying the current batch, compare the proposed work with the original contract. Treat
these as evidence that local fixing must stop:

- the fix needs a new cross-module registry, parser, persistence rule, lifecycle, policy, or owner
  that the approved PR contract did not cover;
- the same conceptual defect reappears through different representations after a local fix;
- the change now spans modules or user journeys unrelated to the stated outcome;
- the PR description no longer explains why the touched systems must change;
- a reviewer asks the implementation to decide product behavior that no approved contract owns;
- fixing one case predictably creates another exception at the same boundary.

Do not use comment count, changed-line count, or elapsed time as the decision rule. Those numbers
are warning signs. The stop is justified by a change in the kind of solution required.
A bounded adjustment to an existing owner already covered by the PR is still a local fix.

## Apply the architecture stop

When the scope checkpoint fails, make no further implementation changes and do not request another
review. Report:

1. the original intent;
2. the supported finding class;
3. the evidence that local fixes no longer solve it;
4. the affected owners and behavior;
5. the smallest viable choices.

Offer the choices that the evidence supports:

- redesign the current PR when the shared change is necessary to meet its original contract;
- restore or narrow the PR to a coherent deliverable, then move the broader work to a separate
  issue and PR;
- reject the review request when it has no supported path or material risk.

Ask the maintainer to choose. Do not select a redesign, split work, create an issue, or change a
product or migration rule by inference. Approval must update the PR contract before an agent
implements the chosen redesign.

If the repository uses pause labels, propose `needs-human-decision` for an unsettled contract and
`needs-architecture-review` for a structural redesign. Apply a label or post a pause comment only
when the current request authorizes GitHub mutations. A pause comment must be in the repository's
required language and contain the evidence and choices above.

Resume only after the maintainer chooses a direction and the PR contract is updated to match it.

## Dispose of the review batch

Record one disposition for every finding:

- fixed at the owning boundary, with meaningful regression evidence;
- rejected, with the unreachable path or immaterial impact demonstrated;
- paused for a named human decision;
- split out after explicit approval, with the current PR's remaining contract stated.

When repository rules require review-thread reactions, replies, or resolution, perform them only
after the disposition is supported. Do not rerun reviewers while known findings or a scope stop are
unresolved.

## Completion check

The review batch is complete only when:

- every finding has an evidence-backed disposition;
- supported siblings of each local defect were checked;
- the PR still matches its original or explicitly revised contract;
- no architecture or contract stop awaits a human decision;
- required focused verification passed on the exact current head;
- every review thread is resolved or explicitly waiting on the maintainer.

Report `PAUSED` instead of success whenever a human decision remains.
