---
title: "Configure AI providers"
wiki_page_id: "p-ai-providers"
---

[Up one level](../02-section-architecture/01-p-architecture.md)

# Configure AI providers

Choose OpenRouter or an authenticated server-side Codex account in the administrator settings. Task-specific choices let planning, writing and research use different supported models.

## Configure credentials

OpenRouter credentials stay on the server. For a self-hosted Codex setup, follow [the account connection guide](../06-section-backend/03-p-codex-server.md); administrators assign which users can use it. Learners receive answers through Nous rather than provider credentials.

## Choose a model

Select the task's model and, where supported, its reasoning level. Image support, structured output and search capabilities depend on the model and provider. A request fails if its selected model lacks a required capability. Web search belongs to supported research tasks.

For the learning rules sent with these requests, see [shared generation instructions](02-p-prompt-engineering.md). For operational measurements, see [AI usage](../06-section-backend/05-p-telemetry-usage.md).

<details><summary>Details</summary>

When changing structured responses, use the shared [strict-output adapter](../../../apps/backend/src/services/strictStructuredOutput.ts). It adapts provider schemas, including optional properties and string constants, while callers validate the restored response against their domain contract. Domain schemas retain their own definitions.

</details>
