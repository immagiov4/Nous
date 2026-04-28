# AI Instructions for Lumina Reader

This file is the canonical project-wide guidance for AI harnesses, agents, and
assistants working in this repository.

## Project Shape

- Frontend app lives in `apps/web/`.
- Shared UI lives in `apps/web/components/`.
- Hooks live in `apps/web/hooks/`.
- Services live in `apps/web/services/`.
- Utilities live in `apps/web/utils/`.
- Shared types live in `apps/web/types.ts`.
- Backend lives in `apps/backend/src/`.
- Optional TTS server lives in `services/tts-server/`.

## Working Rules

- Read the nearest implementation files before editing.
- Prefer the existing architecture and helpers over inventing new patterns.
- Keep changes narrow and aligned with the current module boundaries.
- Do not introduce unrelated refactors in the same patch.
- Remove dead code and duplicate logic introduced by the change.
- Keep names specific and semantically clear.

## Source Of Truth

- Treat code and local templates as the source of truth when docs lag behind.
- Reuse existing constants, hooks, and services before adding new ones.
- Avoid duplicating model names, thresholds, prompt fragments, and style tokens.
- Keep user-facing text in the project language unless a feature explicitly
  requires otherwise.

## UI And Visual Rules

- Preserve the existing visual language in the app.
- Use the repo style guide when changing visible UI.
- Keep layout changes responsive and stable across dark and light mode.
- Avoid generic placeholder visuals when the feature needs a real rendered view.
- For generated visuals, preserve the shared theme tokens and avoid hardcoded
  local styling that bypasses the app's color system.

## AI Workflow Rules

- Keep prompt construction close to the feature that owns it.
- Centralize shared AI prompt constants and environment-specific rules.
- Prefer one shared canonical instructions file over scattered duplicates.
- If a feature changes AI behavior, update the shared instructions file and the
  relevant entrypoint docs together.

## Testing And Validation

- Run the narrowest meaningful validation first.
- Run `npm run quality` or the relevant type/test path when TypeScript code
  changes.
- Do not claim validation passed unless it was actually run.
- Mention any known unrelated failures instead of hiding them.

## Read This From Other Harnesses

- Copilot: `.github/copilot-instructions.md`
- SpecKit / Codex context: `.codex/`
- Human reference: `README.md`

Any harness that supports repository-local instructions should treat this file
as the primary reference and only keep narrower per-tool overrides where they
are truly needed.
