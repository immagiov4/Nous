---
name: quality-workflow
description: Apply the Nous implementation quality procedure from level selection and visual mockup approval through behaviour tests, real-provider integration, trace review, playtest, fix batches, and maintainer hand-off. Use at the start of every implementation task and before implementation or review fixes.
---

# Follow the quality workflow

Read [AGENTS.md](../../../AGENTS.md) first. It owns repository discovery, architecture references, permissions, validation commands, CI, and merge gates. Apply this procedure within those rules.

## Start: state the level and plan the PRs

State the chosen level and its reason before starting work. Use the maintainer's scope; request a decision as `needs-maintainer` when the level cannot be determined without inventing a classification policy.

| Level | Required work |
| --- | --- |
| Local fix | Behaviour tests (a), meaningful performance measurements (b), and `bun run quality`. Apply UI stages (e–f) when the fix affects UI. |
| Medium feature | Local-fix checks plus real-flow integration (c), X-ray (d), and agentic playtest (e). Apply visual hand-off (f) for UI-affecting work. |
| Large or visual feature | All levels, including the functioning mockup and stages a–f. |

For medium and large or visual work, plan PR decomposition and relations up front using `$codebase-design` and `$improve-codebase-architecture`; a local fix skips this architecture review. State each PR's purpose, dependencies, and blocking or follow-up relations. Reference those skills rather than reproducing their methods.

## Visual work: approve a functioning mockup first

1. Build a temporary app page from the app's existing HTML, CSS, and components. Make its scenes, animations, and interactions work visually.
2. Present the functioning mockup to the maintainer and obtain approval before writing production code.
3. Remove the temporary page after approval, then implement the approved result in production code.

## Before every fix: zoom out

Check these planes before an implementation fix or a review fix:

1. **Requirement:** What is this for? Which requested outcome or invariant needs correction?
2. **Architecture:** Is this the right owner? Is it a single instance or a class of problems? Does it need its own module or issue?
3. **Code:** Which supported path reaches the defect? What logic violates the requirement?

For a problem class or an architectural problem, stop patching locally and decompose the work into an issue or follow-up PR. Apply the architecture decision procedure in [receiving-pr-reviews](../receiving-pr-reviews/SKILL.md) and the issue procedure in [problem-to-github-issue](../problem-to-github-issue/SKILL.md).

## Test ladder: run applicable stages in order

### a. Behaviour tests

- Test preconditions, postconditions, expected errors, and invariants through observable behaviour.
- For every new test, deliberately break the code under test once, run the test, and record the failure. Restore the code and record the passing run. A requirement restatement, copy/string check, or assertion of implementation details does not qualify.
- Record the test, deliberate defect, command, observed failure, and restored result so its ability to detect a regression is checkable.
- When the change has no meaningful deterministic boundary (for example behaviour that exists only in nondeterministic model output), follow AGENTS.md: write no tautological test and document the manual or evaluation-based verification instead.
- Run `bun run quality` during iteration alongside the selected behaviour tests; use the focused-check rules in AGENTS.md.

### b. Performance within behaviour and integration tests

- Measure performance inside behaviour and integration tests where meaningful.
- Record durations and relevant metrics per run, with the scenario and run context, so degradation over time is visible. Retain the measurements when running stage c.
- Use only maintainer-set thresholds derived from measured data. If a threshold is needed but unsettled, stop that decision and list it as `needs-maintainer`; supply the measurements instead of choosing a value.

### c. Integration on real provider flows

- Exercise real application flows against each provider the changed flow supports, among OpenRouter and Codex through ChatGPT login (for example, speech synthesis exists only on OpenRouter). Exclude direct OpenAI integration from this workflow's provider checks.
- On each of those providers, pass a simple case first, then realistic cases for the changed flow.
- Record inputs, outcomes, performance measurements, and the real-run trace for stage d.

### d. X-ray of the real-run trace

- Have a model review the recorded trace of a real run step by step for ambiguity, inefficiency, errors, and unexpected reasoning, even when the final result is correct.
- Preserve the trace and the review findings. Apply receiving-pr-reviews to the findings before correcting them.
- Report limits of the recorded evidence; do not infer unrecorded reasoning.

### e. Agentic playtest

- Run `bun run playtest` for UI-affecting work and the levels requiring it. Use AGENTS.md and the [testing wiki](../../../.cubic/wiki/09-section-tools/02-p-testing-quality.md) for setup and supported options.
- Keep browser execution hidden. Record the outcome, the playtest trace and screenshots, and the performance profile for the maintainer. Add the playtest video once the harness records one (issue #194); until then the trace and screenshots are the hand-off evidence.
- Process findings through the zoom-out and review procedures before treating this stage as passed.

### f. Maintainer visual QA

- Hand off the playtest evidence (video when available, otherwise trace and screenshots) and the performance profile to the maintainer for visual QA only after applicable stages a–e pass.
- State the chosen level, passing evidence, and outstanding maintainer decisions. Keep visual QA pending until the maintainer reviews it.

## Route bugs found outside the work

Use this maintainer routing decision after the zoom-out check:

| Finding | Route |
| --- | --- |
| Small and pre-existing | Fix in the same PR (maintainer decision: this deliberately overrides the general minimal-change rule for small pre-existing defects found while doing the work). |
| Serious | Separate issue explicitly marked as blocking this work. |
| Medium, pre-existing, and not critical for this work | Separate non-blocking issue. |

Use problem-to-github-issue for every issue operation, including its live-label and authorization rules. Record blocking and non-blocking relations explicitly. When severity or routing is unsettled, list it as `needs-maintainer`; do not invent severity thresholds or a route for an unspecified case.

## Review and publish complete fix batches

- Apply receiving-pr-reviews to all internal and external feedback, including self-review.
- Keep every valid finding accounted for: fix blocking findings in the PR; route non-blocking findings to a follow-up PR and record its relation to the current PR. Use problem-to-github-issue when an issue is required.
- Apply the maintainer's routing above for small pre-existing bugs. These routing decisions replace receiving-pr-reviews' default of sending all separable findings only to an issue; retain its evidence checks and architecture stops.
- Close the supported problem class and verify the complete fix batch before an authorized push. Each push re-triggers automated review; push only complete batches. Follow AGENTS.md for publication authorization and review completion.

## Final candidate: Sonar once

Use the fast ESLint sonarjs check in `bun run quality` during iteration to catch the same rules early. Verify that the command actually includes that check; report missing wiring as `needs-maintainer` rather than claiming coverage.

Run Sonar once at the end on the final candidate through `bun run gate:full`, following AGENTS.md for CI ordering, scan applicability, and candidate invalidation. Keep Sonar out of the incremental fix loop.

## Completion evidence

Report the selected level, mockup approval and temporary-page removal where required, behaviour-test failure proofs, per-run performance records, provider integration results, X-ray dispositions, playtest evidence, performance profile, visual-QA status, issue/PR relations, and final-gate result. Account for each item as passed, pending, or outside the selected scope. List every unsettled policy or quantitative decision as `needs-maintainer`.
