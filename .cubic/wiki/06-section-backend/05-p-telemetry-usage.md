---
title: "Workflow Events and AI Usage"
wiki_page_id: "p-telemetry-usage"
---

# Workflow Events and AI Usage

Nous records selected workflow events and AI usage to help explain how a course or lesson was produced. These records support diagnosis; the saved workflow state remains the source of truth for whether work completed.

## Workflow events

Events record key changes such as work starting, retrying, waiting, completing or failing. They may include a request ID, operation, status and a short sanitized failure description.

Prompts, source material, provider responses and credentials are excluded from workflow diagnostics.

## AI usage

When a provider reports usage, Nous can record input, output, reasoning and cached tokens, along with the provider, model and reported cost. Some provider paths do not return usage, so totals can be incomplete.

The account usage view covers course and lesson generation. It does not include every chat or audio request. Cached input is part of input usage, and reasoning tokens are part of output usage; they should not be added a second time.

## Cost estimates and retention

When a provider reports a cost, Nous uses that amount. For OpenRouter requests with text-only output, Nous can estimate a missing cost from current model rates when the required token counts and prices are available. Estimates are not historical invoices; other missing costs remain unknown.

Deleting a workflow attempt also deletes its usage records.
