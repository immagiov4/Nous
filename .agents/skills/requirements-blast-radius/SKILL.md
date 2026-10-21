---
name: requirements-blast-radius
description: Map implicit requirements before implementing a substantial new request or steering that changes the agreed outcome. Find every surface delivering the capability and the lifecycle boundaries needed to make the request true for the user.
---

# Requirements blast radius

If this file is outside the current repository and the repository contains `.agents/skills/requirements-blast-radius/SKILL.md`, read and follow that canonical copy instead. Resolve the path from the Git root and its references from the canonical skill directory.

Turn the request into a short, evidenced requirements map before choosing an implementation. The input is the human request and any agreed requirements it changes. For an orchestrator brief containing a `Requirements map` section, reuse that map and investigate only uncovered changes. Handle tiny edits and straightforward localized fixes directly when their outcome and affected path are already clear.

## 1. State the outcome

Describe what the user can do when the work is complete, including preserved behavior. For steering, identify the changed outcome against the agreed map and retain requirements that still apply. Treat the named screen or function as an entry point into discovery.

Complete when the outcome is observable and its scope is distinguishable from implementation choices.

## 2. Find every delivery surface

Read repository instructions and the relevant architecture references. Search for the capability's verbs, domain terms, outputs, provider calls, stored representations and alternate entry points. Follow each path from user action through adapters and shared owners to the delivered result. Include alternate modes, fallbacks, API/CLI callers and consumers of the same representation. Verify search or graph results in source.

Use a configured semantic screen when its evaluation supports this repository and the source is authorized for its provider. Read the ranked source files, starting with the leading hits and continuing through unresolved capability or lifecycle paths. Combine its candidates with lexical search and caller tracing. Treat a score as a reading priority; record incomplete inventories or provider failures as discovery gaps. For setup and evaluation, read [screen.md](references/screen.md).

Complete when every discovered delivery surface has a source-backed disposition: change, re-check, preserved by the contract, or product scope decision. Record the search boundary and remaining unknowns; an empty search establishes only what was searched.

## 3. Walk the lifecycle

Trace a representative operation from start to final delivery and later reuse. Consider each dimension below; keep applicable findings in the map and summarize grounded exclusions together.

- **Duration and limits:** compare expected work with every enclosing client, server, proxy, provider and job deadline; inspect the values and units at their owners.
- **Cancellation and interruption:** follow disconnect, navigation, replacement, shutdown and restart; determine who stops work and releases resources.
- **Retry, idempotency and cost:** identify the operation identity, completed work reused, duplicate side effects or paid calls, and error recovery.
- **Capacity:** account for admission, parallel work, memory, disk, request size and provider limits across the complete path.
- **Progress and errors:** determine what users see during long work, partial completion, rejection and recovery; retain safe diagnostics and accessibility.
- **Persistence:** inspect publication, revisions, cache identity, reload, historical results, migration and explicit regeneration boundaries.
- **Offline and devices:** check supported disconnected behavior, mobile, keyboard/touch, browser differences and responsive delivery.
- **Language and privacy:** inspect authored versus displayed/spoken forms, locale, permissions, data sent to providers and retained artifacts.

Choose technical consequences that follow from established contracts. Bring scope, changed product policy, new spending or numeric product limits to the maintainer through the task's established decision channel. Distinguish a necessary question from a discoverable technical fact. Preserve the user's authorization to implement routine choices.

Complete when each applicable lifecycle boundary has evidence, its implication and a check that could falsify the requirement.

## 4. Produce the requirements map

Use the heading `Requirements map` so delegated work can recognize the handoff. Keep it short:

- **Outcome:** the user-visible result and steering delta, when applicable.
- **Surfaces and lifecycle:** requirement → affected surface/owner → `file:line` at the inspected revision → disposition → observable acceptance check. Group rows sharing one requirement.
- **Technical implications:** decisions the agent can make from existing contracts, with material tradeoffs.
- **Product questions:** only unresolved scope, policy or preference decisions, with the consequence and a recommended option. State when there are none.
- **Discovery gaps:** uncovered consumers, unavailable evidence or incomplete screen results, and the next useful check.

Mark claims as observed in source, inferred, or runtime-verified according to the evidence. Source inspection establishes requirements and ownership; implementation verification establishes behavior. Continue authorized work independent of unresolved questions; route dependent decisions before implementing them. Update the map when later steering changes the outcome.

## Installation

For global or repository installation, use the [install and check instructions](references/screen.md#install-and-check). Repository installs carry the canonical skill, the Claude entry point and both prompt-hook declarations; the repository copy takes precedence over the global hook.
