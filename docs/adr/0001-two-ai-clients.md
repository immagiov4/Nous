# ADR 0001: Two AI clients

## Context

The frontend needs two distinct kinds of AI interaction:

1. **Batch pipelines** — one-shot, fire-and-forget generations: assessment, planning, research, curriculum, lesson content, lesson verification, exercise brief & placement, lesson markdown quality, lesson images, visual examples, document indexing, TTS. These calls share a common shape: one prompt in, one result out, optional streaming of reasoning tokens via SSE.

2. **Interactive chat with tool calls** — multi-turn conversations where the AI can invoke tools to read or mutate project data. Two instances: the Reader Ask-AI panel and the Library home chat.

## Decision

Use two separate AI stacks:

| Stack | Used for | Location |
| --- | --- | --- |
| `callOpenRouter` (custom HTTP client) | Batch pipelines | `services/openrouter/` |
| Vercel AI SDK (`@ai-sdk/react`, `ai`) | Interactive chat with tool calls | `apps/backend/src/routes/contextChat.ts`, `libraryChat.ts`, `hooks/library/useLibraryAssistantChat.ts` |

The backend exposes both:

- `/api/openrouter/chat/completions` — raw proxy for `callOpenRouter`.
- `/api/chat/context` and `/api/chat/library` — Vercel AI SDK streaming protocol (SSE + tool-call envelope).

The AI API key is held server-side in both paths. The browser never receives it.

## Rationale

Vercel AI SDK provides built-in multi-turn history management, streaming, and a tool-call/result envelope with full type safety. Rebuilding an equivalent on top of `callOpenRouter` (which has no history or tool-call protocol) would require replicating all of that infrastructure for no practical gain: the interactive chat paths are not batch-shaped.

Conversely, the batch pipelines need fine-grained control over retry, payload limits, reasoning-token streaming via `onReasoningUpdate`, and per-call model overrides that do not fit the Vercel SDK's chat-oriented abstractions.

## Consequences

- **Do not mix the two stacks in a single feature.** A new batch pipeline goes under `services/openrouter/`. A new interactive chat feature goes through Vercel AI SDK.
- Batch pipelines and interactive chats share no client-side code, but share the server-side API key and the backend proxy infrastructure.
- Adding a new tool to the chat AI requires changes in the backend route and in `services/library/toolExecutor.ts` (for library tools) or the context route handler (for reader tools). No changes to `services/openrouter/` are needed.
- The two stacks evolve independently. Upgrading `@ai-sdk/react` does not affect the batch pipelines, and vice versa.
