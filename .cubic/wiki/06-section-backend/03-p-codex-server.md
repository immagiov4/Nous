---
title: "Private Codex adapter"
wiki_page_id: "p-codex-server"
---

[Up one level](../07-section-ai/01-p-ai-providers.md)

# Private Codex adapter

The Codex adapter connects Nous to an authenticated account on the host through a private `codex app-server` process. Administrators and explicitly assigned users reach that shared connection through the authenticated Nous API. Provider credentials stay with the host account, while the backend owns access and request translation.

## The process is an integration boundary

The host enables the adapter and authenticates Codex as described in [local setup](../09-section-tools/01-p-local-setup.md#optional-codex-text-provider). A request depending on it requires that account and process to be available. The app-server is private to the backend; exposing Nous over HTTPS does not require exposing this internal service.

Its execution environment is restricted and read-only, with built-in shell, browser, computer-control and plugin tools disabled. Instructions also direct the model away from host files, but those instructions alone cannot enforce filesystem restrictions. Review process configuration and tool exposure in [the adapter](../../../apps/backend/src/services/codexAppServer.ts) when changing that boundary.

## Application tools retain their owners

Learning tools run through Nous's normal tool contracts. Some operations execute on the backend; others request a browser workspace action, such as anchoring a note. Model tool output therefore enters application validation and authorization rather than acquiring direct authority over project state. Supported research tasks can expose web search under the provider's research capability.

The adapter translates streaming responses and records available usage. This protocol differs from OpenRouter, but the resulting domain contracts must remain the same for callers. [Shared instructions](../07-section-ai/02-p-prompt-engineering.md) supplies common task meaning, and [usage records](05-p-telemetry-usage.md) explains which measurements are available.

Codex supplies text and supported research work; [speech preparation](../03-section-features/04-p-multimedia.md) still uses OpenRouter. Integration verification needs actual requests through the adapter for the changed flow, with provider-independent domain assertions and separate evidence for stream/tool handling.
