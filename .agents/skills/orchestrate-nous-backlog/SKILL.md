---
name: orchestrate-nous-backlog
description: Orchestrate a Nous backlog run from repository discovery and open-issue triage through user-visible delegation, review, validation, and controlled publication. Keep the Nous-specific discovery, classification, selection, and authority boundaries here; route generic engineering and issue mechanics to the installed skills.
---

# Orchestrate Nous Backlog

Run a current Nous backlog batch as an orchestrator. Do not replay old work: discover the
relevant repositories, inspect current GitHub and repository state, then execute only the
requested/current items. Use the high-throughput PR loop below only when the user authorizes
parallel publication work.

## Separation of responsibilities

This skill owns the Nous-specific work that is not supplied by the companion skills:

- discover every reachable repository that is demonstrably related to Nous, while excluding the
  historical `Lumina-Reader` repository;
- build a complete open-issue map, classify issues into execution lanes, and select issues whose
  contract is clear and whose dependencies and risks are acceptable;
- send bounded, user-visible work to isolated Codex tasks and coordinate their ownership,
  queueing, evidence, and publication authority;
- preserve Nous-specific contracts, local quality gates, manual-verification gates, and GitHub/Git
  boundaries.

Do not duplicate a companion skill's generic procedure. Route the responsibility when it applies,
then read and follow that skill at its installed path. A routing pointer is not permission to take
the action described by the target skill.

| Concern | Route to | Use when |
| --- | --- | --- |
| overall non-trivial engineering workflow | `$engineering-workflow` | an issue needs more than a direct local edit |
| concise, auditable execution style | `$poteto-mode` | the task benefits from its minimal workflow and evidence rules |
| unfamiliar subsystem or historical intent | `$how`, `$why` | grounding or prior trade-offs can change the answer |
| module seam or consequential architecture | `$codebase-design`, `$architect` | interface depth, ownership, or cross-module shape is at stake |
| hard bug or cheap regression seam | `$diagnosing-bugs`, `$tdd` | a bug needs a red-capable loop or a focused regression |
| cross-cutting risk or adversarial challenge | `$blast-radius`, `$interrogate` | the issue has material downstream or contested risk |
| issue lifecycle and evidence ledger | `$problem-to-github-issue` | creating, editing, labeling, commenting on, closing, reopening, deduplicating, or preparing an issue |
| vertical ticket breakdown or durable spec | `$to-tickets`, `$to-spec` | the work must be split or settled decisions must be preserved |
| independent standards/spec review | `$code-review` | a coherent diff needs material review |
| review-comment triage | `$receiving-pr-reviews` | a PR receives human or automated findings |
| primary-source research | `$research` | docs, APIs, or external facts must be investigated |
| durable technical prose or user-facing writing | `$docs-doc`, `$unslop` | documentation or human-facing prose is produced |
| long unattended decision trail or handoff | `$show-me-your-work`, `$handoff` | the run needs an auditable log or another task must resume it |

## Execution authority

Authorization to implement, test, open or maintain a PR, or babysit a task carries the local
execution authority needed to complete that work:

- install or restore only the dependencies required by the existing manifests and lockfiles;
- start, restart, and stop only the local verification environments required by the authorized
  scope, including development services, containers, scanners, and quality gates;
- scale those operations to the host's available resources and serialize heavy verification lanes.

Treat these as execution steps, not blockers: do not request separate authorization or leave the
task unfinished merely because they are required. This authority remains local and scoped. It does
not authorize deployment, external service or data changes, destructive migrations, dependency
upgrades, or unrelated stacks. A command that combines local startup with an out-of-scope mutation
still requires authority for that mutation.

When dispatching a task, include only the applicable `$skill-name` invocations and their exact
installed `SKILL.md` paths. Do not paste or reimplement those skills' instructions. Every dispatched
agent receives the repository instructions, exact issue/scope, exclusive ownership where possible,
output path, authority limits, applicable skill pointers, and a falsifiable completion condition.
For an authorized PR batch, make the post-PR ownership explicit: the agent must keep babysitting its
PR through CI and review cycles until it is merged or reaches a concrete blocker that needs a user
decision. Opening a PR, reporting an initially green CI run, or waiting for an optional reviewer is
not a completion condition.

### Persistent task goals

Every delegated task that can outlive one immediate action must create a Codex goal before it begins
implementation, review, or babysitting. The goal names the concrete outcome, such as a verified
merge, a created evidence-backed issue, or a bounded investigation report. Keep that goal active
across pauses, CI/review cycles, shared-gate queues, and handoffs. A task may report a dependency,
but it does not complete merely because it is waiting: it keeps monitoring the dependency, pursues
any independent safe work, and resumes at the next executable action. Complete the goal only after
the stated outcome is verified; mark it blocked only for a repeated concrete blocker that genuinely
requires user input or an external change.

### Active waiting is work

Treat a live dependency as an active loop, not a reason to end a delegated turn. While CI, review,
an external job, a shared-gate queue, or another owned task can change without user input, keep the
goal active and poll the verified handle with the native waiting mechanism at a proportionate cadence
(normally about two minutes). Process the result, take the next safe action, then wait again. A task
does not self-pause merely because the last poll was unchanged.

Use `blocked` only when the same concrete user-decision or external-state blocker has recurred under
the platform's blocked audit and there is no executable safe work left. In that state, name the exact
decision or state change that resumes the task; the orchestrator must revive it immediately when that
condition arrives. A goal is a durable outcome contract, never a timer or a substitute for monitoring.
Use `$poteto-mode` when its style is suitable; do not force it when a narrower skill is the better
fit.

## 1. Establish the current state

1. Discover all reachable repositories whose names, descriptions, remotes, or documented links
   demonstrably identify them as part of Nous. Record each candidate's URL, role, and relevance.
   Treat the public repository `immagiov4/Nous` as the authoritative product repository and its
   canonical local checkout as `D:\Dev\Nous-Reader`. Other related repositories are context only
   unless the user authorizes work there. Never use the historical `Lumina-Reader` repository as a
   fallback, source of truth, remote target, or PR destination.
2. Read the complete applicable `AGENTS.md` before acting. Re-read it after long runs or context
   compaction.
3. Inspect `git status -sb`, the current branch, remotes, and recent commits. Record the baseline
   HEAD and preserve every pre-existing change. Before a broad or destructive migration, ensure
   there is a recoverable checkpoint; do not create a backup commit or branch without version-
   control authorization.
4. Refresh remote state before triage within the user's Git authorization. Use read-only remote
   inspection when no fetch is authorized; use `git fetch` only when authorized, and use
   `git pull --ff-only` only when the worktree and branch make it safe and the user has authorized
   the pull. Never stash, discard, rebase, merge, or otherwise rewrite user work merely to obtain a
   pull.
5. Before a new task or non-trivial change, read the relevant `.cubic/wiki` pages and form a
   proportional semantic map: product concepts, systems, contracts, analogous mechanisms, and
   likely cross-cutting effects. Use code search or Graphify afterwards to verify concrete call
   paths and file relationships. Do not turn a small local fix into an encyclopedic audit.
6. Load and follow `$engineering-workflow` and `$poteto-mode` when applicable. Load `$supabase` for
   Supabase work and the relevant UI/browser skill for visual work. State the active skills.

## 2. Build the issue map before editing

For every relevant repository, collect the complete open backlog rather than relying on a
summarized view. For the authoritative Nous repository, use:

```powershell
gh issue list --repo immagiov4/Nous --state open --limit 200 --json number,title,body,labels,url,updatedAt
```

Search titles and bodies in Italian and English before opening a duplicate. Read the full issue
body and relevant comments for every selected item. Use `$problem-to-github-issue` before any issue
lifecycle mutation; it owns the evidence ledger, issue contract, readiness transition, and
mutation authorization. Use `$research` for primary-source investigation rather than reproducing
its research procedure here. Use `$to-tickets` when a plan must become independently verifiable
vertical tickets, and `$to-spec` when settled decisions need a durable spec.

Classify each selected issue into exactly one execution lane:

- `autonomous`: the contract is clear and implementation is independently actionable;
- `interactive`: one or more user choices materially change the implementation;
- `brainstorm`: product direction must be discussed before code;
- `verification`: code may already satisfy the issue and needs evidence or manual QA;
- `blocked`: external authority, unavailable state, or a real dependency prevents progress.

Select the most suitable or least risky issues only from explicit acceptance criteria, real
dependencies, authority, and verified risk. Do not invent a project-specific score, ranking,
filter, fallback, or semantic heuristic. If a selection requires such a rule, stop under the exact
heading `EURISTICA PROPOSTA`, state the decision rule and failure modes, and ask the user.

Present the classification briefly. Begin autonomous work immediately; handle interactive and
brainstorm items with the user in a separate, sequential question stream. Write newly opened
GitHub issues in English unless the user requests another language. If documentation review
exposes a real product bug or missing capability rather than stale prose, open a separate
evidence-backed issue instead of hiding it in a documentation patch.

## 3. Delegate bounded work in parallel

For implementation, use separate user-visible Codex tasks with isolated worktrees, not hidden
subagents. Use a local subagent only for a short, read-only verification that supports the current
chat; never use one to implement, publish, or own a backlog issue. Keep roughly 8-10 tasks or fewer
active and queue excess work.

1. Group overlapping issues by subsystem before creating tasks. Select the model deliberately:
   use `gpt-5.6-sol` with `high` reasoning for complex/high-impact implementation,
   `gpt-5.6-terra` with `high` reasoning for medium implementation, and `gpt-5.6-luna` only for
   bounded exploration (`medium`/`high`, or `xhigh` when complex) or simple documentation-only
   implementation (`high`). Do not use Luna for non-trivial code implementation.
2. Give each agent a concrete outcome, exact issue(s), validation expectations, exclusive
   file/module ownership where possible, and the applicable installed skills from the routing
   table above.
3. Do not let agents edit the same files concurrently. Use isolated worktrees only when the
   environment supports them and integration cost is justified.
4. Keep the main agent responsible for repository context, user questions, integration, cross-
   cutting contracts, and final publication. Read every delegated artifact and diff yourself.
5. Follow the user's publication authority exactly. When the user authorizes the high-throughput
   PR loop, each agent may commit its scoped diff, push a branch, open a non-draft PR, respond to
   genuine automated-review findings, and merge only when the defined conditions are met.
   Otherwise, do not infer any of those permissions. For governance-only `AGENTS.md` edits
   explicitly authorized by the user, update and push directly to Nous `main` after verifying the
   remote and clean scope; do not create a PR merely for that.
6. Use `$show-me-your-work` for a long unattended run when a TSV decision trail materially helps a
   later reviewer. Use `$handoff` only when a separate task needs a redacted continuation document.

Keep useful local work moving while agents run. Send concise progress updates at least once per
minute during long operations.

### Orchestration health checks

At least every 20 minutes during an active batch, and again whenever the queue appears idle,
perform a short orchestration audit before declaring a task blocked or waiting:

1. List active, queued, and paused tasks; count heavy local work, active reviews, CI runs, and
   shared-service lanes.
2. For every paused task, name its exact dependency and verify that it is real on the current
   head. Do not preserve a dependency merely because it was once prudent.
3. Ask whether another safe path can advance now: focused tests, CI/review, rebase, a different
   non-conflicting task, an existing service configuration, or an already-authorized merge.
4. Detect both under-parallelization (tasks waiting unnecessarily) and over-parallelization (too
   many CPU/RAM-heavy checks or overlapping ownership). Start or resume only work that has a
   genuine independent lane; queue the rest.
5. Treat optional/rate-limited reviewers as advisory unless the user explicitly made them a gate.
   Never let an optional reviewer, a docs-only scan, or a superseded caution silently block a
   merge.
6. If a shared gate is genuinely serial, keep only that gate serial. Continue all non-conflicting
   review, CI, rebase, documentation, and focused-validation work in parallel.

Report the concrete dependency and the next executable action, not just that something is
“waiting.” If the audit finds no real blocker and publication authority already exists, advance
the PR rather than asking again.

## 4. Implement with Nous-specific contracts

Route generic engineering execution through `$engineering-workflow` and `$poteto-mode` when
applicable. For the issue type, add `$diagnosing-bugs`, `$tdd`, `$architect`, `$blast-radius`, or
another routed skill; do not copy their playbooks into this section.

Apply these Nous-specific rules to every workstream:

- Prefer the smallest direct change that satisfies the real contract. Delete obsolete paths instead
  of adding compatibility layers when the user requires no legacy or fallback.
- Preserve existing behavior outside the issue scope.
- Treat ownership boundaries as explicit end-to-end contracts. Require callers to name the intended
  workflow/model/backend; reject missing or legacy identifiers instead of silently remapping them.
- For delicate persistence, migration, concurrency, archive, or orchestration changes, use
  `$tdd` and strict red-green-refactor discipline when a meaningful seam exists.
- Write meaningful tests for observable behavior, persistence, failure recovery, concurrency,
  schemas, and round-trips. Do not add tests that merely assert prompt text contains a word or
  sentence.
- Do not use regexes or keyword lists to infer semantics from nondeterministic model output.
- Keep source data complete and recoverable. For large archives, avoid concatenating everything into
  one prompt; retain the original complete tree/index, bounded previews, and explicit file/directory
  selectors.
- When changing Supabase, apply migrations locally without resetting user data; verify migration
  history, schema/storage behavior, tenant isolation, and database lint/advisors as applicable.
  Update code, deployment, host scripts, environment examples, and canonical docs together.
- When changing import/export or persistence, prove round-trip fidelity and exercise the largest
  supported/reported size outside the permanent suite when a permanent stress test would burden CI.
- For visual/UI changes, verify the rendered result in the appropriate light/dark and mobile/desktop
  states. If browser tooling cannot observe the relevant API or surface, say so; never claim visual
  QA passed.

## 5. Run the review and validation loop

After each coherent block, verify the smallest meaningful artifact first. Use `$code-review` for
the independent standards/spec review, `$blast-radius` for material cross-cutting risk, and
`$receiving-pr-reviews` before changing code in response to human or automated PR findings. Use
`$interrogate` only when adversarial review is requested or genuinely needed. These skills own
review mechanics; this skill retains the Nous-specific gates below.

1. Run the narrowest meaningful tests first.
2. Run the cheap, relevant checks: type checks, formatter/linter, focused static/security checks,
   and the smallest service or Supabase contract that proves the changed boundary. Inspect
   `git diff --check`, staged scope, deletions, generated artifacts, and secrets before publication.
3. In the high-throughput PR loop, open the PR after focused tests plus quality pass. Use GitHub CI
   and configured automated reviewers as the parallel review surface. Reserve broad local gates for
   the final merge head when required by the merge policy.
4. Wait for CI and required automated reviewers. Use a native periodic monitor, normally about
   every two minutes, rather than assuming comments arrive immediately. Treat optional or
   rate-limited reviewers as non-blocking unless the user explicitly promoted them to a gate.
5. Treat only concrete, reproducible review findings as work. Apply the disposition rules from
   `$receiving-pr-reviews`; fix genuine findings at their owning boundary with targeted validation,
   and explain unsupported findings with evidence.
6. Serialize host-heavy local gates. Run at most one full gate/coverage/Sonar lane at a time. For
   behavior-changing code, tests, security, build, dependency, or configuration changes, run the
   final local `bun run gate:full`/Sonar gate on the exact merge head before merge when the user
   requires it. If that head changes after review fixes, repeat the final gate only for the new
   head. Do not run Sonar for documentation-only or trivial metadata-only changes; do not start
   competing scanners, rotate shared tokens, or change global Sonar configuration while another
   scan is active.
7. If a full local gate fails under host contention, classify it as infrastructure contention,
   preserve its output, and rely on focused checks plus fresh CI rather than calling it a code
   regression.

Use test and review results as evidence, not ceremony. Do not broaden the patch merely to make
unrelated checks green.

## 6. Preserve the manual-verification gate

When a result depends on a real browser, large user file, authenticated persistence, deployment, or
visual judgment:

1. Finish implementation and automated validation.
2. Tell the user exactly what to exercise and what success looks like, with an isolated loopback URL
   if a PR branch must be run locally. Local lifecycle authority does not cover a startup command
   that also applies a destructive migration, stages data, or mutates an external service.
3. Follow the user's chosen placement of visual QA. If it can only be meaningful after merge, merge
   after automated gates and treat production QA as a follow-up, never as passed pre-merge
   verification.
4. Do not claim visual QA passed without actually performing it.

Do not interpret “implement it” as permission to commit, push, merge, deploy, close issues, or
mutate external services or data.

## 7. Publish deliberately

Before publication, re-check remote state and the complete worktree.

- Stage only the approved scope. Use `git add -A` only when the user explicitly approved the whole
  worktree.
- Scan staged additions for credentials and inspect every hit; environment-variable references are
  not literal secrets.
- Use a terse commit message describing the whole diff.
- Push directly to `main` only when the user explicitly requests that route. Otherwise use the
  repository's branch/PR workflow.
- Confirm local HEAD and remote branch SHA after push, then report the CI URL/status.
- Before creating a pull request or issue, run `bun run github:body -- preview` on its body file;
  create with the native `--body-file` option, then run `bun run github:body -- verify`. For later
  body mutations, use `bun run github:body -- update`; keep body text out of shell interpolation
  and `gh pr edit`/`gh issue edit`.
- Use `$problem-to-github-issue` before any issue mutation and `$to-tickets` before publishing a
  ticket breakdown. In every PR description, name each resolved issue using GitHub-closing
  references where appropriate (for example, `Closes #123`). Before completion, verify that every
  resolved issue was actually closed; never leave a completed issue orphaned/open without an
  explicit remaining manual-verification reason.
- For a documentation-only PR, keep Markdown valid: headings, blank lines, lists, and closing
  references must render correctly. Correct documentation findings manually on the same PR; do not
  regenerate Cubic merely to answer a review.
- Do not close an issue merely because tests pass. Leave manual-verification issues open or apply
  the established “should be closed” state only when requested.

## 8. High-throughput PR checklist

Use this only after the user has approved the loop.

1. Classify and separate overlapping files before parallelizing. Cap active heavy validation to
   avoid CPU/RAM starvation; parallel agents may implement and run focused checks while only one
   broad gate runs.
2. Per autonomous issue: synchronize the worktree, implement the narrow contract using the routed
   skills, run focused tests plus `bun run quality`, inspect the diff, commit, push, and open a
   non-draft PR.
3. Monitor the PR continuously for CI and reviewer comments. Do not confuse Security Review,
   Greptile, Cubic, and Codex Code Review; report which actually ran. Do not stop babysitting after
   opening the PR or after a clean snapshot: keep polling with a bounded native monitor, process
   genuine findings, and begin a fresh CI/review cycle after every material change.
4. Fix genuine comments in small commits. Before changing code, use `$receiving-pr-reviews`; wait
   for a fresh CI/review cycle after each material fix.
5. Merge automatically only when the user authorized it, the applicable CI/review gates are clean,
   all genuine review threads are resolved, and the proportional final local gate policy is
   satisfied. A known CI failure unrelated to a documentation-only diff may be waived only when the
   user explicitly authorizes that exception.
   Once this authority exists, continue the PR loop until the merge is verified. The only legitimate
   stopping states are: merged; a concrete user decision or manual-verification gate; or a specific
   external/infrastructure blocker with its next executable action. Do not leave a ready PR merely
   awaiting an unspecified future check.
6. Report throughput as outcomes: already-fixed/no-op issues closed, PRs opened, merged PRs, PRs
   awaiting CI, PRs awaiting user QA, and real blockers.

## 9. Completion report

Lead with the outcome. Include:

- relevant repositories discovered and which one was authoritative;
- issues completed, deferred, blocked, or awaiting user input;
- important behavioral contracts and migrations;
- automated and manual validation actually performed;
- review findings and corrections;
- pre-existing failures kept out of scope;
- commit, push, PR, deployment, or issue state only when those actions truly occurred.

Never make the final answer depend on collapsed progress commentary.
