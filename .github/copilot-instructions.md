# Copilot Instructions — Lumina Deep Reader

Tailored to this repository: React 19 + TypeScript + Vite frontend at the repo root · Express.js + TypeScript backend in `backend/` · Python Qwen3-TTS server in `tts-server/` · IndexedDB persistence · Gemini-driven learning, assessment, and text-to-speech flows.

---

## Scope and Priority

- Prefer minimal, surgical changes aligned with the existing architecture.
- Do not introduce unrelated refactors in the same patch.
- Keep behavior stable unless the task explicitly requires behavior changes.
- This repo is evolving quickly: docs may lag behind implementation, so trust the code over the docs when they disagree.

---

## Context-First Workflow

- Before coding, read the closest implementation files to the change.
- For frontend work, inspect `App.tsx`, the relevant files in `components/`, `hooks/`, `services/`, and `utils/` before introducing new patterns.
- For backend work, inspect `backend/src/routes/`, `backend/src/services/`, and `backend/src/config/` before editing behavior.
- For TTS changes, determine whether the change belongs in frontend playback code, the Node backend proxy/process manager, or the Python server before modifying anything.
- If the issue is a bug, identify the root cause pattern and search sibling modules for the same mistake.
- Use docs for orientation, but treat the implementation as the source of truth.

---

## Stack and Project Layout

### Frontend — repository root

- The main application entry is `App.tsx`, not `src/App.tsx`.
- Shared React components live in `components/`.
- Custom hooks live in `hooks/`.
- Frontend services live in `services/`.
- Shared utilities live in `utils/`.
- Shared frontend types live in `types.ts`; shared constants live in `constants.ts`.
- The app is a stateful single-page interface managed directly from `App.tsx`; do not assume React Router is in use.
- When adding visible functionality, wire it into the existing component tree from `App.tsx` instead of introducing a parallel page architecture.

### Backend — `backend/src/`

- Express app bootstrap lives in `backend/src/index.ts`.
- Route handlers live in `backend/src/routes/`.
- Business logic and integration code live in `backend/src/services/`.
- Runtime configuration lives in `backend/src/config/`.
- Shared backend types live in `backend/src/types/`.
- The backend is primarily a control plane and proxy for TTS-related operations; keep UI-specific logic out of it.

### Python TTS server — `tts-server/`

- `tts-server/` is an integrated Python service used by the backend and frontend TTS flow.
- Prefer the smallest possible change when editing Python files there.
- Favor configuration or backend orchestration changes over deep Python changes unless the task clearly requires modifying the server internals.
- Avoid broad cleanup or style-only edits in `tts-server/`; it contains upstream-style code and research artifacts.

### Dev Commands

```bash
npm run dev           # frontend + backend
npm run dev:frontend  # frontend only
npm run dev:backend   # backend only
npm run dev:tts       # Python TTS server only
npm run quality       # frontend/backend type checks + Biome lint
```

---

## Architecture Notes

### Frontend application flow

- `App.tsx` is the main state orchestrator for reading, assessment, learning-plan, focus-mode, and library flows.
- `hooks/useProjectLibrary.ts` owns IndexedDB-backed project persistence and workspace hydration.
- `hooks/useTtsPlayer.ts` owns text chunking, playback state, sync behavior, and client-side TTS playback orchestration.
- `services/geminiService.ts` is the public frontend facade for Gemini capabilities; feature-specific implementations live under `services/gemini/`.
- `services/projectSnapshot.ts` and repository services are the canonical path for persisted project data.

### Backend TTS flow

- `backend/src/services/processManager.ts` manages the lifecycle of the Python TTS server.
- `backend/src/routes/tts.ts`, `voices.ts`, and `status.ts` define the backend API surface consumed by the frontend.
- `backend/src/services/ttsClient.ts`, `voiceService.ts`, and `statusService.ts` should stay the single source of truth for backend TTS integration logic.
- If a change affects TTS availability or startup behavior, check both the Node process manager and the Python server contract.

### Persistence

- Project persistence is client-side and IndexedDB-backed, not database-backed.
- Reuse `IndexedDbProjectRepository` and existing snapshot types instead of inventing new persistence paths.
- Do not move project state to the backend unless the task explicitly asks for a server-side persistence change.

---

## UI and Styling Rules

- Preserve the existing visual language already used in `App.tsx` and `components/`.
- Use Tailwind utility classes for styling; avoid inline styles except where computed values or CSS custom properties are genuinely required.
- Use `lucide-react` for icons.
- Keep components focused and composable; if logic grows, extract a hook or utility instead of expanding an already large render block.
- Prefer extending the existing components in `components/` over introducing a new competing pattern.

---

## AI and Content Rules

- Keep Gemini-specific logic inside `services/gemini/` or the Gemini service facade.
- Reuse exported service functions from `services/geminiService.ts` rather than calling low-level Gemini modules ad hoc from unrelated files.
- Keep prompt construction and response parsing close to the existing Gemini modules that already own that feature.
- For markdown, lesson content, and speech preparation, reuse existing utilities before adding new text-processing logic.

---

## Code Quality Standards

### Cognitive Complexity

- Prefer guard clauses and early returns over nested conditionals.
- Extract focused helpers when a function starts mixing unrelated responsibilities.
- Keep changes readable inside large orchestrator files like `App.tsx` and `useTtsPlayer.ts`.

### No Magic Numbers or Strings

- Avoid sprinkling repeated thresholds, storage keys, model names, and route fragments inline.
- Promote reused literals into nearby `const` declarations in the owning module.
- Reuse existing constants before adding new ones.

### Single Source of Truth

- Do not duplicate Gemini integration logic, project snapshot logic, or TTS connection logic.
- If behavior already exists in a hook, service, or utility, extend it there instead of recreating it elsewhere.

### Fail Fast

- Add guards at true uncertainty boundaries: user input, uploaded files, browser APIs, network responses, and external process output.
- Do not add defensive branches solely to satisfy tooling if the value is guaranteed by the flow.

### Wiring Completeness

- When adding a feature, complete the wiring in the same patch.
- Frontend changes should include the state hookup, service usage, and UI entry point.
- Backend changes should include route registration, service wiring, and any config/types updates needed for the feature to be reachable.

---

## Error Handling

- Never swallow exceptions silently; log with `console.error` at minimum.
- Backend responses should return user-safe error payloads and keep raw stack details in server logs only.
- Frontend errors should use the existing UI patterns for surfaced failures instead of `alert()` or silent failure.
- Preserve existing helper patterns such as local `getErrorMessage()` functions when they are already established in nearby code.

---

## TypeScript Conventions

- All new frontend and backend code should be TypeScript.
- Use explicit types for public function boundaries, service contracts, and component props.
- Use `interface` for object shapes and `type` for unions or aliases.
- Avoid `any` unless there is no practical alternative and the boundary is documented by the surrounding code.
- Prefer `async/await` over raw promise chains.

---

## Frontend-Specific Rules

- Keep `App.tsx` as the top-level orchestrator unless there is a clear need to extract self-contained logic.
- Pages do not live under `src/pages/`; do not introduce that structure unless the project is explicitly being reorganized.
- Use custom hooks for stateful logic that would otherwise bloat components.
- Reuse `react-markdown`, `react-syntax-highlighter`, `remark-math`, and `rehype-katex` for rich content rendering instead of introducing overlapping libraries.
- For file and content processing, reuse existing utilities such as ZIP handling and reading helpers before adding new parsing flows.

---

## Backend-Specific Rules

- Keep route files thin; put integration and orchestration logic in backend services.
- Keep process lifecycle behavior centralized in `processManager.ts`.
- Do not hardcode configuration values in route handlers when they already belong in `server.config.json` or backend config utilities.
- Preserve the existing `/api/tts`, `/api/voices`, and `/api/status` API shape unless the task explicitly requires an API change.

---

## TTS Server Rules

- Treat `tts-server/` as a specialized subsystem with heavier runtime and test cost.
- Make targeted edits only in files directly related to the requested behavior.
- Do not rewrite benchmarks, research notes, or auxiliary scripts unless the task is specifically about them.
- If changing request or response behavior, verify compatibility with both the backend client and the frontend TTS hook.

---

## Testing and Verification

- After TypeScript changes, prefer running `npm run quality`.
- For backend-only TypeScript changes, at minimum run the backend build or type check path.
- For frontend-only changes, ensure the Vite app still type-checks.
- If startup or integration wiring changes, run `npm run dev` and confirm frontend and backend start without errors.
- If you change Python TTS behavior, run the narrowest relevant verification in `tts-server/` rather than broad heavyweight benchmarks unless required.
- Do not fix unrelated failing tests unless they block the requested change.

---

## Documentation

- Keep `README.md`, `SETUP.md`, or other nearby docs aligned when the user-facing setup or architecture actually changes.
- Write documentation as stable reference material, not change-log prose.
- Keep comments concise and factual.

---

## Contribution Hygiene

- Remove dead code and unused imports introduced by your change.
- Keep public interfaces stable unless the task explicitly requires changing them.
- Prefer small, focused patches with clear intent.

---

## Pre-Implementation Checklist

1. Read the relevant implementation files near the change.
2. Check for existing helpers, constants, and types before adding new ones.
3. Verify whether the change belongs in frontend code, backend code, or the Python TTS server.
4. Trace existing usages before renaming or moving anything.
5. Run the narrowest meaningful validation, and run `npm run quality` when the change touches TypeScript code paths.
