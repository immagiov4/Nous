# Nous Reader — Agent Instructions

IMPORTANT: these guidelines are your bible, read them all completely, do not infer, read them and check on them periodically. If the requested task is complicated and will run for long, read this file again to refresh your context and to prevent context compaction and context drift.

## graphify

This project has a Graphify knowledge graph at `graphify-out/` and an MCP that
can query it. Use it selectively when relationships across files or modules are
the question, not as a mandatory prelude to every code task.

Use Graphify for:
- cross-module ownership and dependency questions;
- component-to-controller-to-service-to-persistence paths;
- blast-radius and affected-code analysis;
- unclear architectural boundaries or subsystem relationships.

Do not use Graphify for local symbol lookup, exact-text search, a change already
confined to known files, or as a substitute for reading the implementation.

Workflow:
1. At the start of graph work, run `graphify reflect --if-stale` and read
   `graphify-out/reflections/LESSONS.md` when it exists.
2. Check freshness before querying. If relevant tracked or untracked code has
   changed since the graph was built and the watcher is not known to be healthy,
   run `graphify update .` just in time and wait for it to succeed. Do not run a
   blocking update merely because a task modified code or is ending.
3. Ask one bounded graph question with `graphify query`, `graphify path`,
   `graphify affected`, or `graphify explain`. Read `GRAPH_REPORT.md` or the wiki
   only when community structure or broad subsystem orientation is relevant.
4. Verify graph-derived claims in the cited source files before relying on them.
5. Save the result with `graphify save-result` and an honest `--outcome`:
   `useful` only when it materially narrowed the investigation or added a correct
   insight, `dead_end` when it did not help, and `corrected` with `--correction`
   when source inspection disproved it.

Freshness and failure rules:
- The background watcher is the normal way to cover uncommitted code changes;
  post-commit and post-checkout hooks are best-effort maintenance only.
- Before starting a watcher, check whether one already targets this repository;
  keep exactly one watcher process. Its logs belong under
  `~/.cache/graphify-watch-lumina*.log`; hook rebuilds use
  `~/.cache/graphify-rebuild.log`.
- Watcher and hook rebuilds must remain asynchronous and non-blocking. Their
  lock and pending-change queue prevent concurrent rebuilds from piling up.
- If a just-in-time update or query fails, say that the graph may be stale,
  inspect the Graphify log, and fall back to `rg` plus direct source inspection.
  Never silently answer from a graph known to be stale or broken.
- `graphify update . --no-cluster` is acceptable only for a deliberately narrow
  dependency/path query. It does not refresh community data or
  `GRAPH_REPORT.md`, so do not use it before community or architecture-summary
  work.
- If `graphify-out/wiki/index.md` exists, prefer it over opening generated wiki
  files indiscriminately.

## Quick Map
Core Philosophy → Context Before Code → Simplicity → Naming → Single Source of Truth → Magic Numbers → Configuration Constants → Modularity & Helpers → Parameters → Error Handling → Comments → Code Style → Runtime Assumptions → Localization → UI Design → Event Handling → Data Ordering → Security → Testing → Bug Fixing → Change Discipline → Confirmation → Version Control → Performance → State & Side Effects → Dead Code → Tradeoffs → Output Style → Final Checklist

## Working Rules

- Read the nearest implementation files before editing.
- Prefer the existing architecture and helpers over inventing new patterns.
- Keep changes narrow and aligned with the current module boundaries.
- Do not introduce unrelated refactors in the same patch.
- Remove dead code and duplicate logic introduced by the change.
- Keep names specific and semantically clear.
- Do not introduce a project-specific heuristic for ranking, classification, ordering, placement, filtering, fallback selection, or semantic inference without explicit developer approval. When proposing one, label the question clearly as `EURISTICA PROPOSTA` and explain its decision rule and failure modes so it cannot be mistaken for a routine clarification. Established standard algorithms and deterministic validation of an explicit contract do not require this extra approval.
- Do not introduce or change collateral product behavior or any quantitative threshold without explicit developer approval. This includes timeouts, token limits, context budgets, retry counts, concurrency caps, file-size limits, rate limits, fallback cutoffs, distribution curves, ranking weights, and similar policies. Discovering that a limit is needed does not authorize choosing its value: ask before implementing or changing the number or policy.

## Task Model Selection

Use the execution model deliberately:

- Complex or high-impact implementation: `gpt-5.6-sol` with `high` reasoning.
- Medium-scope implementation: `gpt-5.6-terra` with `high` reasoning.
- Simple bounded exploration: `gpt-5.6-luna` with `medium` or `high` reasoning.
- Complex exploration: `gpt-5.6-luna` with `xhigh` reasoning.
- Simple documentation-only implementation: `gpt-5.6-luna` with `high` reasoning.

Do not use Luna for non-trivial code implementation. Run implementation work in separate visible Codex tasks with isolated worktrees; use local subagents only for short, read-only verification in the current chat.
## Product Manifesto

This project has a living product/design manifesto in GitHub discussion #33 (https://github.com/immagiov4/Lumina-Reader/discussions/33):
`Manifesto strategico e di design di Nous Reader`.

Before making or prioritizing product, UX, AI-behavior, business-strategy, or
major architecture decisions, read the manifesto and align the work with it.
Treat it as the strategic north star for what Nous Reader is and is not:
an ADHD-friendly, step-by-step learning environment for understanding whole
subjects, not a generic chat app, file drive, or content-creation suite.

The manifesto does not override code reality or explicit developer direction,
but it should guide tradeoffs around learning flow, mobile usability,
multimodality, pedagogical tone, Deep Research, pricing assumptions, and whether
a feature is core or better left to external tools.

## Source Of Truth — Project Layer

- Treat code and local templates as the source of truth when docs lag.
- Reuse existing constants, hooks, and services before adding new ones.
- Avoid duplicating model names, thresholds, prompt fragments, and style tokens.
- Keep AI prompt construction close to the feature that owns it.
- Centralize shared AI prompt constants and environment-specific rules.
- If a feature changes AI behavior, update the shared instructions and entrypoint docs together.

## Validation Commands

```bash
bun run doctor        # Read-only diagnostic; defaults to the checks profile
bun run doctor -- --profile gate   # Probe the existing local Sonar service
bun run doctor -- --profile local  # Probe local Supabase services and migration parity
bun run doctor -- --profile all    # Run checks plus every service probe
bun run quality       # TypeScript type checks + Biome lint
bun run check:fallow  # Static dead-code & duplication analysis (info only)
bun run gate          # Full gate: quality + fallow + tests
bun run gate:full     # Local full gate: checks + test coverage + Sonar
bun run gate:ci       # CI gate: quality + fallow regression + tests
bun run fix           # Auto-fix Biome lint, format, and import ordering
bun run format        # Format all files (Biome)
bun run test          # Vitest test suite (runs under Bun runtime)
```

`doctor` is observational in every profile: it reports `PASS`/`FAIL`/`WARN`/`SKIP` results without
starting, restarting, configuring, or migrating services. The default `checks` profile runs the
service-free checks; `gate` probes Sonar, `local` probes Supabase and migration parity, and `all`
combines them. `gate:full` starts with `doctor:gate`, runs quality, Semgrep, the Fallow regression
check, and the Bun suite as independent lanes, then runs coverage and Sonar analysis sequentially;
it completes every stage and exits with failure if any stage fails.

Run the narrowest meaningful validation first. Before completing a non-trivial local batch,
run `bun run gate:full`; it must still reach Sonar when an earlier stage fails. Triage every new
Sonar bug, vulnerability, and security hotspot, and reduce safe unresolved code-smell debt by at
least 10 findings per batch when that much safe debt remains. Use `bun run fix` to auto-fix lint and
format issues.
Do not claim validation passed unless it was actually run.

## Core Philosophy

Write code that is easy to understand, easy to change, and difficult to misuse.

Prefer clear structure over cleverness, explicit intent over implicit behavior, and consistency over local convenience. The goal is not merely to make the code work, but to make future modifications safer and faster.

Before changing code, first understand the surrounding codebase. Do not implement solutions in isolation. Existing architecture, naming conventions, utilities, constants, error handling patterns, and domain assumptions matter.

## Context Before Code

Before writing or modifying code, gather enough contextual awareness:

1. Read nearby files and similar implementations.
2. Identify existing helpers, constants, types, services, and utilities.
3. Check how related functionality is already structured.
4. Verify where the code is imported or called.
5. Avoid recreating logic that already exists elsewhere.
6. Prefer extending existing patterns over inventing a new local style.
7. Check root-level and module-local documentation relevant to the area. When external API behavior matters, verify the authoritative documentation for the supported version instead of relying on memory.

Do not start from a blank-slate design unless the existing structure is genuinely broken.

## Simplicity and Cognitive Complexity

Keep individual functions small enough to reason about. Functions should do one coherent thing. As a practical target, keep cognitive complexity below 15.

Reduce complexity by:
- Using guard clauses instead of deeply nested conditionals
- Extracting real responsibilities into helpers
- Replacing nested ternaries with named functions
- Separating validation, transformation, side effects, and rendering logic
- Avoiding large multipurpose functions

Do not re-check invariants already guaranteed by earlier control flow, framework lifecycle, or an immediately preceding operation. Each guard should rule out a distinct failure mode; otherwise remove it or assert the invariant.

A bad pattern is a single function that validates input, transforms data, handles permissions, updates state, logs errors, formats UI output, and triggers side effects. A better pattern is one coordinator function with specific helpers for each concern.

Helpers must earn their existence. Do not create one-line pass-through wrappers that merely rename a direct assignment or call without adding semantic value. Three similar lines is better than a premature abstraction — do not design for hypothetical future requirements.

## Naming

Names should be semantically decodable at a glance. A reader should understand what a variable, function, type, or parameter represents without inspecting its full implementation.

Prefer names that answer: what is this, why does it exist, what state or behavior does it represent, and is this input, output, configuration, derived state, or a side effect?

Avoid names that are too generic (handle, process, data, item, value, manager, onRemove) unless context makes them obvious. Also avoid names tied to implementation details that may change. Do not repeat context already clear from the file, module, class, or object.

Naming is part of code review — re-check names before finishing a change.

## Single Source of Truth

Do not duplicate constants, strings, formulas, validation rules, or business logic. If a value or rule appears in multiple places, centralize it.

This applies to: error messages, validation limits, UI labels, colors, timing values, permission rules, status names, configuration defaults, and transformation logic. Duplicated values create hidden coupling. One change should update the whole system without hunting through the codebase.

## No Magic Numbers or Magic Strings

Avoid unexplained literals in logic. Domain-specific numbers and strings must always be named:
- Bad: `wait(1000)`, `items.length > 100`, `status == "active"`, `width = 14.6`
- Better: `wait(TIMING.RETRY_DELAY_MS)`, `items.length > VALIDATION.MAX_ITEMS`, `status == STATUS.ACTIVE`, `width = LAYOUT.CONTENT_WIDTH`

Literals are acceptable only when their meaning is immediate and local (0, 1, simple loop indexes, trivial arithmetic). For coupled layout, timing, or configuration values, define source constants and derive the rest.

## Configuration and Aesthetic Constants

Visual, layout, timing, and behavioral constants should be centralized. Do not hardcode colors, sizes, durations, spacing, labels, thresholds, or limits directly inside UI or business logic.

Use the project's existing palette, spacing scale, timing constants, and configuration objects. Prefer derived metrics when values depend on each other — define source constants and compute dependent ones. This makes changes safer and prevents subtle drift.

## Modularity and Helpers

Group related files by responsibility. When a feature grows, split it into a small local module structure instead of letting one file become a monolith.

Good modularization separates real concerns: main component/controller, validation, formatting, persistence, rendering, and domain calculations. Bad modularization creates tiny files that cannot be understood alone.

Split a file when it mixes unrelated responsibilities, functions become hard to test, helpers are reused across multiple places, or the same conceptual group keeps appearing repeatedly.

Helpers should encode meaningful responsibility: clarifying a domain rule, isolating a reusable calculation, hiding repetitive but meaningful setup, or centralizing a pattern used in multiple places. A helper that wraps a single assignment without adding meaning should not exist. For recurring generic patterns, prefer a shared general helper over many one-off microhelpers.

Keep variables in the narrowest useful scope. Do not promote one-use values, literals, or temporary calculations to module scope merely to name them; use module-level state only when separate functions genuinely share it.

## Parameters and Configuration Objects

When a function needs more than three or four parameters, use a configuration object or structured input type. This makes call sites clearer, reduces argument-order bugs, and allows future extension without breaking every caller.

## Error Handling

Error handling should be explicit, safe, and consistent.

- Do not expose internal implementation details to users. Log technical details internally; show stable user-facing messages. Never show raw `error.message` values directly to users.
- Use centralized error messages and error codes when appropriate.
- Do not silently swallow errors unless the operation is genuinely optional and failure is expected.

**Assertions vs defensive checks:** when a value should logically exist because execution flow guarantees it, prefer an assertion or explicit failure over a defensive fallback that masks broken state. Defensive checks are appropriate for public APIs, external input, async callbacks, optional integrations, and recoverable user-driven conditions — not merely to silence tooling or make code "feel safer".

Bad: silently returning when `currentUser` is missing even though the caller already validated a user exists. Better: asserting that `currentUser` must exist after the authentication check. Silent failure makes bugs harder to detect and turns invalid states into mysterious behavior.

## Comments and Documentation

Comments should explain intent, tradeoffs, invariants, and non-obvious behavior. Well-named identifiers already explain *what* the code does — comments explain *why*.

Do not comment obvious assignments or trivial getters. The test: if removing the comment wouldn't confuse a reader unfamiliar with the code, don't write it.
- Bad: `// Get user` before `user = getUser()`
- Good: `// This branch intentionally avoids caching because permissions may change during the session`

Use short comments above substantial control-flow blocks when the purpose is non-obvious. Do not write comments referencing change history or the conversation — comments should be factual and impersonal.

For public functions, modules, components, or complex helpers, document the responsibility and any non-obvious assumptions, side effects, or tradeoffs concisely. Avoid exhaustive field lists, caller narration, and mechanical walkthroughs.

## Code Style and Modern APIs

Use modern, standard APIs when they improve clarity, safety, or portability:
1. Use explicit radix when parsing numbers.
2. Use sets or maps for frequent membership lookups.
3. Use environment-neutral global access when applicable.
4. Prefer built-in string/list operations over custom loops when clearer.
5. Avoid deprecated APIs unless required by the runtime.

Do not modernize blindly if the project runtime does not support the newer API. Always respect target runtime and compatibility constraints.

## Runtime and Platform Assumptions

Do not add compatibility layers unless the project explicitly supports multiple runtimes. If the environment is too old, failing clearly is better than silently degrading. Do not add defensive compatibility checks for APIs guaranteed by the project's stated requirements. When intentionally avoiding a standard API, add a short comment explaining why.

## Localization and User-Facing Text

Follow the project's localization and language conventions. Centralize strings where the project already does so. Do not mix languages in UI. Technical comments may use the language dominant in the codebase.

Keep implementation terminology out of the product interface. Internal names such as chunks, IDs, storage keys, tool names, provider details, and excessive diagnostic detail belong in logs or developer diagnostics, not in user-facing labels, progress messages, errors, or source attribution. Translate internal structures into the user's domain language, such as document names and page ranges.

## UI and Interaction Design

UI code should minimize visual noise and avoid redundant feedback:
- Do not show success messages for obvious actions unless confirmation is genuinely useful.
- Centralize aesthetic decisions: colors, spacing, animation timings, layout dimensions.
- Use consistent visual patterns across similar UI elements.
- Do not fix layout bugs by randomly forcing sizes — understand the layout model and fix the underlying constraint.
- Do not use blur or `backdrop-filter` as decorative UI defaults. Introduce either only when functionally necessary and after verifying performance on the affected devices and browsers, especially mobile Firefox.
- When rendering dynamic lists from unordered data structures, sort before display for a stable UI.

Before writing any UI component, identify the existing component patterns in the codebase. Extend what exists. Do not invent new visual patterns unless none exist.

## Event Handling and Re-rendering

Interactive elements should not cause state updates or redraws unless something meaningful changed. Before updating state, compare the new value with the current value.

Bad: saving and redrawing every time an event fires, even when the value has not changed. Better: returning without update when the new value equals the current value.

This matters especially in dense forms, scrollable panels, text fields, dropdowns, live previews, and any UI that receives frequent events. Avoid tying scroll position, hover state, or transient UI state to expensive full rebuilds.

## Data Ordering and Stability

Never rely on undefined iteration order when rendering UI, serializing output, generating files, or comparing results. If order matters, make it explicit: sort alphabetically, by date, by priority, by configured order, or by guaranteed insertion order. Stable output reduces visual jitter, test flakiness, and debugging confusion.

## Security and Input Handling

Treat external input as untrusted. Sanitize and validate before use in persistence, rendering, queries, or security-sensitive logic.

Never expose internal errors, stack traces, paths, tokens, or configuration secrets to users. Permission checks must exist at the authoritative layer (backend/service). Frontend checks improve UX but are not enforcement. Prefer allowlists over blocklists for constrained input.

## Testing and Validation

After making changes, validate using the project's available tools: tests, linters, type checks, local scripts, or manual verification.

For automated tests: test critical paths thoroughly, test utility modules more deeply, test integrations around real user flows, isolate time/randomness/network/external services, and clean up mocks and test state after each test.

Only add tests that can catch a meaningful regression in behavior, contracts, transformations, rendering, persistence, or user flows. Do not add tests that merely assert that source text contains a keyword, substring, letter, prompt sentence, label, or other implementation wording. Such tests freeze copy without proving that generated output or runtime behavior is correct, create false confidence, and add maintenance cost. Prompt tests must exercise a meaningful boundary whenever feasible, for example structured prompt composition, precedence between instruction layers, schema enforcement, parsing, validation, or an observable generation contract. If a behavior cannot be tested meaningfully without calling a nondeterministic external model, prefer no automated test over a tautological string-inclusion test; document the manual or evaluation-based verification instead.

Do not infer semantic meaning, workflow state, user intent, generation phase, content quality, or language from literal regexes or keyword lists applied to nondeterministic model output. Regexes are appropriate for deterministic syntax and explicitly defined formats, not as a substitute for semantic classification. Use authoritative orchestrator events where the workflow owns the state; where a state exists only inside a model's reasoning or generated stream, use a structured model classification with an explicit schema and enforce invariants such as monotonic progression in code.

For manual-only projects, explain what must be verified and where. If validation reveals unrelated pre-existing failures, mention them clearly instead of hiding them.

## Bug Fixing Methodology

When fixing a bug, identify the root pattern, then search for similar occurrences:

1. Determine the root cause.
2. Search the same file for the same pattern.
3. Search related modules.
4. Search tests, examples, docs, and duplicated logic.
5. Fix all relevant occurrences.
6. Validate the broader pattern is gone.

Do not close your eyes after one local fix.

## Change Discipline

Prefer minimal, direct changes that solve the real problem. Do not add features, refactor, or introduce abstractions beyond what the task requires. A bug fix does not need surrounding cleanup. When modifying existing code:
1. Preserve current behavior unless the change requires otherwise.
2. Avoid breaking public interfaces casually.
3. Keep imports clean and remove dead code.
4. Avoid unused variables.
5. Keep naming consistent with surrounding style.
6. Do not mix refactors with behavior changes unless necessary.

If a change requires a larger refactor, explain why.

## Confirmation Before Code Changes

Before any action, evaluate its reversibility and blast radius. Local, reversible changes (editing files, running tests) can proceed freely. Hard-to-reverse or broadly impactful actions (deleting data, modifying shared state, destructive refactors) require explicit confirmation before proceeding.

When acting as a coding assistant, do not modify code before explaining the issue and receiving approval, unless the user has explicitly asked for direct implementation.

For exploratory questions ("what could we do about X?", "how should we approach this?") respond in 2-3 sentences: one recommendation, one main tradeoff. Present it as a direction the user can redirect, not a decided plan. Do not implement until the user explicitly confirms.

For debugging tasks: show exact evidence (files, functions, lines), explain the faulty logic, propose one or more fix approaches, recommend the best option with tradeoffs, then wait for confirmation before editing.

## Version Control Discipline

Do not run state-changing version control commands without explicit approval. Never commit, push, rebase, reset, amend, stash, stage, or otherwise mutate repository state unless explicitly requested. Read-only commands are acceptable for context.

When a Codex GitHub review is requested, treat an eyes reaction as review-in-progress and wait for the completed review before merging. React to every Codex finding with thumbs up or thumbs down, reply with the evidence-based disposition, and do not leave its thread unresolved: resolve it only after the fix is merged or the finding is explicitly rejected with evidence.

For every pull request, name every issue it resolves in the pull-request description with GitHub-closing references where appropriate (for example, `Closes #123`). Before reporting the work complete, verify that each resolved issue was actually closed. Do not leave a completed issue open without an explicit reason such as a remaining manual-verification gate.

## Performance Awareness

Avoid unnecessary work in hot paths: repeated full re-renders, expensive loops inside frequent events, repeated parsing or formatting, linear searches on large collections, redundant network or database calls, rebuilding UI during scroll or typing.

Use appropriate data structures. Cache or memoize only when cost and invalidation rules justify it. Do not prematurely optimize cold code, but do not ignore obvious hot-path waste.

## State and Side Effects

Keep state transitions explicit. Separate: calculating what should happen, validating whether it may happen, applying the mutation, notifying the user, and logging or recording metrics. Avoid hidden side effects inside functions that look like pure calculations. When state may change asynchronously, write code that acknowledges that possibility.

## Dead Code and Cleanup

Remove unused code quickly. Dead variables, unused helpers, duplicate blocks, stale comments, and abandoned branches increase maintenance cost. Trust the linter, but verify before deletion if the project uses dynamic imports, reflection, registration side effects, or framework conventions.

## Documentation of Non-Obvious Tradeoffs

When code intentionally does something surprising, document the tradeoff in a short, factual comment close to the relevant code. Examples: avoiding a standard API for performance or compatibility, using a custom implementation due to framework limitations, keeping a workaround for a known runtime bug, not validating a value because an earlier invariant guarantees it.

## Preferred Output Style for Code Changes

1. Provide complete, usable code rather than vague fragments when implementation is requested.
2. Avoid placeholders unless explicitly requested.
3. Preserve existing behavior.
4. Explain assumptions only when they matter.
5. Mention validation steps performed or still required.
6. Identify pre-existing unrelated issues separately.

Do not claim tests passed unless they were actually run.

## Final Review Checklist

Before considering a change complete, verify that:

1. The solution follows existing project patterns.
2. No duplicated constants, strings, or logic were introduced.
3. Function complexity stayed reasonable.
4. Names are clear and semantically accurate.
5. No unnecessary defensive checks were added.
6. No silent failure hides a real bug.
7. User-facing text follows the project language/localization rules.
8. UI updates happen only when meaningful state changes.
9. Dynamic output order is stable where needed.
10. No dead imports, variables, helpers, or comments remain.
11. Relevant tests, checks, or manual validation steps were run or documented.
12. No state-changing version control command was executed without approval.
