# Review Fix Progress

## Completed

- Hardened backend auth/CORS defaults and LAN development configuration.
- Removed client-side OpenRouter key usage by routing model calls through backend APIs.
- Added runtime validation around project snapshot persistence and chat route inputs.
- Centralized timestamp generation with `timestampIso()` across backend and frontend source files.
- Centralized line-ending normalization and clipping helpers in the web code.
- Centralized project sync state constants and entity-id helpers where practical.
- Extracted shared PDF data URL validation/decoding for backend PDF routes and services.
- Consolidated PDF reasoning helpers used by planning, generation, and context chat.
- Consolidated backend web-search tool schemas and web-search mandate prompt text.
- Named chat, retry, search, cache, status, web-search token, and TTS timing/result limits.
- Reduced duplicated TTS model/type/voice fallback definitions.
- Removed the old local Python/Qwen TTS runtime path; TTS now goes through OpenRouter only.
- Made malformed optional JSON config files fail clearly instead of silently falling back.
- Added stable SQLite ordering for reads and shared sibling insertion logic for folder/project moves.
- Split `App.tsx` composition helpers for model defaults, PDF mapping warnings, app dialogs, initial section auto-open, and reader shell props.
- Split markdown rendering normalization into code heuristics, math normalization, fenced-code repair, and segment processing modules.
- Extracted annotation text projection and selection resolution from `sectionAnnotations.ts`.
- Extracted annotation mark parsing, range rewriting, and document-order sorting from `sectionAnnotations.ts`.
- Consolidated planning source profiling, adaptive guidance, search keywords, and plan-section deduplication into a shared `planQuality.ts` module.
- Extracted PDF lesson image selection, labels, placeholders, and generated visual fallback from `planning.ts`.
- Extracted lesson Markdown cleanup, paragraph deduplication, quiz normalization, and Markdown repair from `planning.ts`.
- Extracted lesson response schema, payload parsing, and final verification prompt/call from `planning.ts`.
- Extracted PDF lesson chunk debug payloads and relevant image-page estimation from `planning.ts`.
- Raised PDF-only backend JSON capacity, returns 413 for oversized bodies, and clips truncated PDF prompt text to 80% of the caller budget.
- Kept debug tracing in place; only reduced avoidable overhead where already safe.

## Intentionally Deferred

- Reader/context-menu hot-path rewrites, unless a specific regression is being fixed.
- Backend/frontend project metadata unification through a shared package, because that needs a larger packaging decision.
- Deeper `planning.ts` lesson-generation decomposition beyond the shared planning-quality rules.

## Validation

After each batch, the current baseline has been checked with:

- `npm run check:biome`
- `npm run lint:frontend`
- `npm run lint:backend`
- `npm test`
