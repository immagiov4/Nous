---
title: "Workflow observability and usage"
wiki_page_id: "p-telemetry-usage"
---

[Up one level](../02-section-architecture/02-p-workflow-engine.md)

# Workflow observability and usage

A run can have provider usage even when generation fails, and a completion event alone does not show which lesson version was committed. Investigation therefore starts by choosing the record that answers the question, then correlates it with the others.

| Question | Evidence |
| --- | --- |
| Did the run complete, fail or remain waiting? | Persisted workflow state. |
| What transitions led there? | Workflow events and request-correlated diagnostics. |
| What provider usage was recorded? | Usage measurements attached to the attempt. |
| What content did the reader receive? | Committed project state. |

## Follow the request through committed transitions

A request identifier connects HTTP handling to saved work and sanitized failure information. Events expose transitions such as claiming, waiting, retrying and recovery; transactional events are recorded after their associated commits. This lets investigation distinguish an attempted mutation from one the database accepted.

Support diagnostics exclude prompts, source material, provider payloads and credentials. Investigating generated reasoning needs the actual model context, so [content evaluation](../09-section-tools/02-p-testing-quality.md#evaluate-generated-content) captures those exchanges separately in private evidence outside Git. The ordinary event stream deliberately cannot reconstruct them.

## Read usage totals within their scope

The account usage view covers course and lesson generation, rather than every chat and audio call. Within that scope, provider measurements can include input, output, cached and reasoning tokens. Cached tokens already belong to input and reasoning tokens to output; adding the subsets again would inflate the total.

Cost has a similar distinction between a reported measurement and an estimate. Provider-reported cost takes precedence. Text-only OpenRouter calls can estimate a missing cost when token counts and current rates are available; other missing costs remain unknown. Available pricing does not reconstruct a historical invoice, and deleting an attempt also removes its usage records, limiting historical totals.

Use [workflow observability](../../../apps/backend/src/workflows/workflowObservability.ts) for transition recording and [account usage](../../../apps/backend/src/account/accountUsage.ts) for aggregation. Keep these distinctions in their output contracts so a consumer can tell what a reported total actually covers.
