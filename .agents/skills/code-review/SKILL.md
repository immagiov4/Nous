---
name: code-review
description: "Review a branch, PR, or work-in-progress diff along two axes: repository standards and the originating spec. Runs both reviews in parallel, calibrates findings to the project's actual risk, and reports only material problems."
---

Two-axis review of the diff between `HEAD` and a fixed point the user supplies:

- **Standards**: does the code conform to this repo's documented coding standards?
- **Spec**: does the code faithfully implement the originating issue / spec?

Both axes run as **parallel sub-agents** so they do not influence each other's conclusions. This skill then checks their findings against the project's risk before reporting them.

## Materiality gate

Calibrate the review to the software in front of you. A personal utility, a game add-on, and critical production infrastructure do not need the same defensive depth.

Report a finding only when all three conditions hold:

1. The diff contains evidence for it.
2. A realistic execution path reaches it.
3. The likely impact justifies the code, tests, and maintenance needed to fix it.

Judge severity from likelihood and impact together. A rare path still matters when it can cause a security breach, data loss, silent corruption, or a costly outage. A theoretical edge case with a cheap manual workaround usually does not. Do not turn advisory linter output, a possible smell, or a preference into a finding without a concrete consequence in this project.

Apply the user's stated tolerance first. Then use repository context such as deployment model, users, stored data, trust boundaries, and recovery cost. When the context is unclear, use the least dramatic interpretation supported by the repository.

## Process

### 1. Pin the fixed point

Use the comparison the user supplied. For a branch or PR, capture `git diff <fixed-point>...HEAD` and `git log <fixed-point>..HEAD --oneline`. For the current worktree, use `HEAD` when the user gives no other point, capture `git diff HEAD`, and list untracked files with `git ls-files --others --exclude-standard`.

Before going further, confirm the fixed point resolves (`git rev-parse <fixed-point>`) and the diff is non-empty. A bad ref or empty diff should fail here, not inside two parallel sub-agents.

### 2. Identify the spec source

Look for the originating spec, in this order:

1. Issue references in the commit messages (`#123`, `Closes #45`, GitLab `!67`, etc.). If `docs/agents/issue-tracker.md` exists, use its workflow.
2. A path the user passed as an argument.
3. A spec file under `docs/`, `specs/`, or `.scratch/` matching the branch name or feature.
4. The user's request and acceptance criteria from the conversation.

If nothing is found, skip the **Spec** sub-agent and report "no spec available". Ask the user only when the missing spec would materially change the review scope.

### 3. Identify the standards sources

Anything in the repo that documents how code should be written, such as `CODING_STANDARDS.md` or `CONTRIBUTING.md`.

On top of whatever the repo documents, the Standards axis always carries the **smell baseline** below: a fixed set of Fowler code smells (_Refactoring_, ch.3) that applies even when a repo documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation. Like any standard here, skip anything tooling already enforces.

Each smell reads *what it is* → *how to fix*. Match it against the diff only when it passes the materiality gate:

- **Mysterious Name**: a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code**: the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy**: a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps**: the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession**: a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches**: the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery**: one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change**: one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality**: abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains**: long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man**: a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest**: a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

### 4. Spawn both sub-agents in parallel

**Standards sub-agent prompt** should include:

- The full diff command and commit list.
- The list of standards-source files you found in step 3, **plus the smell baseline from step 3** pasted in full (the sub-agent has no other access to it).
- The project's risk context and the materiality gate above.
- The brief: "Report only material violations of documented standards and material baseline smells. Cite the standard or name the smell, quote the relevant hunk, and state the realistic consequence in this project. Documented repository rules override the smell baseline. Tooling output is evidence only when it points to a concrete problem. Omit preferences and low-value edge cases. Under 400 words."

**Spec sub-agent prompt** should include:

- The diff command and commit list.
- The path or fetched contents of the spec.
- The project's risk context and the materiality gate above.
- The brief: "Report material requirements that are missing or partial, material scope creep, and implementations that violate the spec. Quote the relevant spec line and state the realistic consequence. Omit harmless differences, preferences, and edge cases whose likely cost is lower than the fix. Under 400 words."

If the spec is missing, skip the Spec sub-agent and note this in the final report.

### 5. Aggregate

Before applying corrections, use
[receiving-pr-reviews](../receiving-pr-reviews/SKILL.md) to validate and dispose of
findings, including those from local agents and subsequent self-review. For user
decisions during a long-running task, use
[agent-question-notifications](../agent-question-notifications/SKILL.md).
A review-only request remains read-only.

Present the two reports under `## Standards` and `## Spec` headings. Keep the axes separate, but remove duplicates and findings that do not pass the materiality gate. Do not inflate a weak finding because both agents mentioned it.

End with a one-line summary: total findings per axis, and the worst issue _within each axis_ (if any). Don't pick a single winner across axes: that's the reranking the separation exists to prevent.

## Why two axes

A change can pass one axis and fail the other:

- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the project's conventions → **Spec pass, Standards fail.**

Reporting them separately stops one axis from masking the other.
