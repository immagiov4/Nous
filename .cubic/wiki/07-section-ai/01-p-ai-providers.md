---
title: "AI Providers"
wiki_page_id: "p-ai-providers"
---

# AI Providers

Nous can send AI requests through OpenRouter or through an authenticated Codex account. Administrators choose the default provider and can set a different provider for supported tasks such as course planning, lesson writing or research.

## Choosing models

Model settings are grouped by task so one choice can serve course planning while another serves lesson writing or research. Where supported, administrators can also choose a reasoning level for a task.

Available models, reasoning options, image support and web search depend on the provider and selected model. A request can fail when the model does not support a feature its task requires.

## Credentials and account access

OpenRouter credentials stay on the server. A self-hosted instance can instead connect an authenticated Codex account on its host. In that mode, access is granted to administrators and assigned users; learners do not receive the account credential.

The [Codex account integration](../06-section-backend/03-p-codex-server.md) page describes its access boundary and restricted execution environment.

## Requests and tools

Some backend operations connect directly to the provider. Web search is available only in supported research tasks.
