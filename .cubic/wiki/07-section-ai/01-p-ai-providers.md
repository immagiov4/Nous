---
title: "AI and speech provider boundaries"
wiki_page_id: "p-ai-providers"
---

[Up one level](../02-section-architecture/01-p-architecture.md)

# AI and speech provider boundaries

The backend routes text tasks through OpenRouter or the installation's private Codex connection. Task-specific model choices let context preparation, planning, writing and research use different supported capabilities. Speech synthesis has a separate OpenRouter client, so a text provider assignment does not determine every external call in a lesson's lifecycle.

## Capabilities are checked at the request boundary

Credentials remain on the server. Model configuration and account assignments select the permitted provider, while the request still needs the capabilities required by its task. Images, structured output and research search depend on the model and provider. Requests requiring a capability fail when it is unavailable.

Some paths explicitly permit text-only work without an optional image: artifact correction can omit an unsupported preview, and the proxy can remove image input when the caller authorizes that fallback. Those exceptions belong to [visual generation](../../../apps/backend/src/services/lessonGenerationVisuals.ts) and the [provider proxy](../../../apps/backend/src/routes/openRouterProxy.ts), preserving each task's required inputs.

The [Codex adapter](../06-section-backend/03-p-codex-server.md) translates its private process protocol and application tools. OpenRouter uses its server API path. Both feed domain services that expect the same task meaning, supported by [shared generation instructions](02-p-prompt-engineering.md). Provider differences belong at these adapters rather than in duplicated course rules.

## Structured output has two representations

Domain schemas describe the application's accepted data. A provider can require a stricter schema representation, so the [strict-output adapter](../../../apps/backend/src/services/strictStructuredOutput.ts) translates the request schema and normalizes the returned payload before domain validation. For example, optional non-null properties can be represented as required nullable fields at the provider boundary, then restored to omitted values on return.

Normalization restores representation; the caller still validates against its original domain contract. This keeps a provider's schema restrictions from becoming product semantics or weakening validation for every other caller.

## Scanned-page transcription

Scanned pages use OpenRouter with only OpenAI admitted and provider fallbacks disabled, independently of the account's text provider. Course scanned pages 1–150 use `openai/gpt-6-luna` with xhigh reasoning; pages 151–300 use Luna medium. Usable native-text pages consume no allowance, and file boundaries do not reset it. Admission above 300 returns a plain Italian instruction to narrow the material. Retained authoritative provenance seeds the count, excluding replaced files. The source job shares 32 request slots, with at most two calls per page; successful responses report usage and provider cost when available. [Source ingestion](../03-section-features/03-p-doc-processing.md#recover-scanned-pages-before-publication) describes preparation, deadlines and failure reporting.

Course and factual-review prompts receive the shared transcription-provenance rule. Structured generation opts into that interpretation explicitly for semantic scene generation with transcribed provenance; exact-copy playback calls preserve supplied text. The factual reviewer uses its evidence-reference validator when accepting a justified correction.

## Audio is a separate external effect

The [speech client](../../../apps/backend/src/services/ttsClient.ts) sends narration to OpenRouter, resolves voice compatibility and validates supported audio responses. [Playback preparation](../03-section-features/04-p-multimedia.md) consumes that audio alongside scene cues.
