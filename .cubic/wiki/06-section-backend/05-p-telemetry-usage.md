---
title: "Workflow observability and usage"
wiki_page_id: "p-telemetry-usage"
---

[Up one level](../02-section-architecture/02-p-workflow-engine.md)

# Workflow observability and usage

Workflow events explain selected state transitions, and usage records describe measurements returned by provider calls. Persisted workflow state establishes whether work completed. These records serve different diagnostic questions, so a token count or a completion event should be interpreted alongside the saved run and committed project state.

## Correlate a failure through its lifecycle

Events cover creation, deduplication, claiming, waiting, retries, completion, failure, cancellation and recovery. Request identifiers connect the originating HTTP request to saved work and sanitized failure information. Transactional events are recorded after their associated commits, preserving the distinction between an attempted mutation and an accepted state transition.

Workflow diagnostics exclude prompts, source material, provider payloads and credentials. Full model exchanges captured by local evaluation have a different privacy scope and belong in private evidence outside Git. [Content evaluation](../09-section-tools/02-p-testing-quality.md#evaluate-generated-content) owns that capture path; the product's support diagnostics cannot substitute for it when investigating generated reasoning.

## Interpret available usage without double counting

The account usage view covers course and lesson generation, rather than every chat and audio request. Provider measurements may include input, output, reasoning and cached tokens, plus cost. Cached tokens are already included in input and reasoning tokens in output, so summing those categories again inflates usage.

Provider-reported cost takes precedence. Text-only OpenRouter calls can estimate a missing cost when the required token counts and current rates are available; other missing costs stay unknown. Those estimates use the available pricing information rather than reconstructing a historical invoice. Deleting a workflow attempt deletes its usage records, which also limits historical totals.

Follow [workflow observability](../../../apps/backend/src/workflows/workflowObservability.ts) and [account usage](../../../apps/backend/src/account/accountUsage.ts) when changing diagnostics or aggregation. Keep execution status, measured usage and estimated cost distinct in both contracts and reports so downstream consumers can preserve the same evidence boundaries.
