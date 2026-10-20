---
title: "Read workflow events and AI usage"
wiki_page_id: "p-telemetry-usage"
---

[Up one level](../02-section-architecture/01-p-architecture.md)

# Read workflow events and AI usage

Events explain selected transitions in a run; usage records describe measurements returned by its provider. Use the saved workflow state to establish whether work completed.

## Diagnose a run

Events record starting, claiming, retrying, waiting, completing, failing, cancellation and recovery. Request identifiers and sanitized failure descriptions connect support observations to a run. Workflow diagnostics exclude prompts, source material, provider payloads and credentials.

Local evaluation captures have a different scope and can contain full model exchanges. Their handling belongs to [testing generated content](../09-section-tools/02-p-testing-quality.md#evaluate-generated-content).

## Interpret totals

The account usage view covers course and lesson generation rather than every chat or audio request. Provider measurements can include input, output, reasoning and cached tokens plus cost. Cached tokens are included in input, and reasoning tokens in output; adding them again double-counts usage.

Provider-reported cost takes precedence. Text-only OpenRouter calls can estimate a missing cost when required token counts and current rates are available. Other missing costs remain unknown. Estimates are not historical invoices, and deleting a workflow attempt deletes its usage records.
