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
- Kept debug tracing in place; only reduced avoidable overhead where already safe.

## Intentionally Deferred

- Large frontend structural refactors such as splitting `App.tsx`.
- Reader/context-menu hot-path rewrites, unless a specific regression is being fixed.
- Backend/frontend project metadata unification through a shared package, because that needs a larger packaging decision.
- Full planning/planGeneration consolidation beyond already extracted PDF reasoning helpers.

## Validation

After each batch, the current baseline has been checked with:

- `npm run check:biome`
- `npm run lint:frontend`
- `npm run lint:backend`
- `npm test`
