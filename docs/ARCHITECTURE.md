# Nous Reader Architecture

This document explains how Nous Reader is organized and where to make changes.

## What Nous Reader does

Nous Reader takes a document source (typically a PDF) and generates a personalized study flow: onboarding chat, study plan, lessons, quizzes, and application exercises that are intercalated between lessons in the path and evaluated by AI.

AI generation runs in two parallel infrastructures (see [Two AI Clients](#two-ai-clients) below). The backend proxies AI calls, extracts text and images from PDFs, validates Supabase Auth sessions, persists projects through the server repository, and provides TTS.

## Runtime pieces

The application is made of two separate runtimes:

| Piece | Default port | Purpose |
| --- | --- | --- |
| Frontend (`apps/web/`) | 5173 | React UI and most client-side orchestration (including AI calls) |
| Backend (`apps/backend/`) | 3301 | API server for auth-gated AI proxy, PDF extraction, project storage, admin routes, and TTS |

`packages/shared-types/` holds the type-only contract used on the wire between the two (see [Shared types](#9-shared-types)). It is type-level only; nothing executes from it.

## Frontend entry point

`App.tsx` is the composition root. It wires together the domain, controller, reader state, navigation, file actions, and library chat, then chooses one of four screens based on `screenState`:

- Library
- Assessment
- Planning
- Reading

The screen switch itself is simple, but `App.tsx` still coordinates a few cross-cutting behaviors such as project auto-opening, the course-generation notes dialog, and top-level file inputs.

## Frontend layers

Think of the frontend as a set of concentric layers.

### 1. Services

`services/` contains plain TypeScript modules. They should not import React hooks.

Important subfolders:

- `services/openrouter/` — OpenRouter HTTP client, prompt builders, model selection, retry, payload limits, and the **AI pipelines** for assessment, planning, research, curriculum, lesson generation, lesson verification, lesson markdown quality, lesson images, visual examples, PDF indexing, and TTS. The biggest folder in the frontend, with subfolders for `documentIndex/`, `lessonMarkdownQuality/`, `planning/`, and `exercises/` (exercise brief and placement pipelines).
- `services/exercises/` — application-exercise domain: pure plan operations (`plan.ts`), constants, and deliverable handling (attachments + zip).
- `services/learning/` — pure functions on the learning plan that are not exercise-specific: sub-chapter grouping and legacy migration for old "mini-lab" lessons.
- `services/projects/` — `ProjectRepository` interface, HTTP adapter, server-only repository factory, project snapshot helpers, archives, persistence signatures, persist queue, sync state.
- `services/workspace/` — domain reducer (`domain.ts`), persistence helpers, workflow selectors, and pure controller logic under `controller/` (`documentAssets.ts`, `learnMode.ts`, `snapshotHydration.ts`).
- `services/library/` — library assistant tool execution.
- `services/preferences/` — UI preference persistence and library folder expansion storage.
- `services/audio/` — voice profile definitions and helpers.
- `services/core/` — shared utilities such as tracing and error normalization.

### 2. Domain

The workspace domain lives in `services/workspace/domain.ts` and is exposed through `hooks/workspace/useWorkspaceDomain.ts`.

This is the source of truth for the current project payload:

- source document
- learning plan (modules → lessons + application exercises intercalated)
- PDF assets and document index
- learner profile and syllabus
- research course plan and per-section research dossiers (used by research mode)
- active section id
- learn mode flag

It should not know anything about the screen the user is on.

Application exercises live inside `learningPlan.modules[].children` as `PathNode` entries with `kind: 'exercise'`, intercalated with lessons. There is no separate laboratory state. See [Shared types](#9-shared-types).

### 3. Controller

`hooks/workspace/useWorkspaceController.ts` is the public entry point for workspace behavior. The real logic is split across `hooks/workspace/controller/`.

Controller modules:

- `assessmentPlanning.ts` — onboarding chat, study-plan creation, and the start of home-chat-driven flows.
- `sectionProgression.ts` — opening, completing, regenerating, and progressing through sections; library return.
- `projectLifecycle.ts` — create, open, save, delete, export, source reattachment.
- `projectImport.ts` — import from JSON.
- `state.ts` — controller state model, including the **workflow tracking** (`requestId` + status per workflow) and the session-state reset (`resetSessionState`).
- `controllerContext.ts` — shared controller context and dependency wiring.
- `createWorkspaceController.ts` — factory for constructing the controller.
- `types.ts` — controller-specific type definitions, including `WorkspaceControllerStateAdapter`.

A parallel controller layer lives at `services/workspace/controller/` for pure (non-hook) workspace logic:

- `documentAssets.ts` — PDF asset coordination.
- `learnMode.ts` — learn-mode state transitions.
- `snapshotHydration.ts` — snapshot loading: legacy plan migration, removal of dropped `laboratory`/`activeLaboratoryExerciseId` fields from old snapshots, markdown normalization, and lesson annotation migration.

If you are adding a new user-visible operation, it usually belongs here.

### 4. Reader state

`hooks/workspace/useWorkspaceReaderState.ts` holds visual state, not project state:

- focus mode
- dark mode
- mobile sidebar state
- context menu state
- text selection state
- audio player state
- preferred OpenRouter models
- settings panel expansion state

It composes smaller reader hooks from `hooks/reader/`:

- `useReaderChrome`
- `useReaderContext`
- `useReaderSpeech.ts` for speech-block extraction
- `useTtsPlayer`

### 5. Reader actions

`hooks/workspace/useWorkspaceReaderActions.ts` translates gestures into coordinated operations.

Examples:

- sidebar selection opens a section, then closes the mobile sidebar if needed
- text selection can open the context answer panel or create a new lesson
- highlights and notes update the current section annotation state
- section completion advances the journey

Actions do not decide whether an operation is valid. That belongs to the controller.

### 6. Navigation

`hooks/workspace/useWorkspaceNavigation.ts` manages transitions between macro screens and URL state.

It handles:

- opening a project from the library or from a route
- returning to the library
- syncing the project id into the location

### 7. Library hooks

The library has its own small subsystem:

- `hooks/library/useProjectLibrary.ts` — server project repository, folders, autosave, import/export.
- `hooks/library/useLibraryAssistantChat.ts` — library assistant chat (Vercel AI SDK; see [Two AI Clients](#two-ai-clients)).
- `hooks/library/usePersistedLibraryFolderExpansion.ts` — which folders are expanded (localStorage).

### 8. UI components

`components/` should stay rendering-focused.

- `components/library/` — library screen, project cards, folder tree (drag & drop), home chat panel.
- `components/assessment/` — onboarding screen.
- `components/workspace/` — reader shell, header, sidebar, content, audio player, context menu, ask-AI panel, overlays.
- `components/shared/` — loading screen, markdown rendering, reader settings panel, shared UI.

Components should not call services directly when a hook can own the behavior instead.

### 9. Shared types

Two type homes:

**`apps/web/types.ts`** holds the rich domain contract for the frontend app:

- `AppState`
- `ProjectSnapshot` (frontend variant: strictly typed against the rich domain)
- `LearningPlan` (modules)
- `LearningSection` (base for a node in the plan)
- `LessonNode` (`kind: 'lesson'`)
- `ApplicationExerciseNode` (`kind: 'exercise'`)
- `PathNode` (`LessonNode | ApplicationExerciseNode`)
- `ResearchCoursePlan`, `ResearchLessonDossier`, `ResearchDossiersBySectionId`
- `UiPreferences`
- `LibraryTree`, `LibraryProjectNode`, `LibraryFolderNode`
- `PdfDocumentAssets`, `PdfTextIndex`, `PdfTextChunk`, `PdfImageAsset`, `PdfTextPage`
- `QuizQuestion`, `SectionAnnotation`, `LessonImageRef`, `LessonGeneratedVisual`, `ExerciseAttachment`

**`packages/shared-types/projectContract.ts`** holds the wire contract shared between the frontend and the backend, imported via the `@shared/*` alias:

- `ProjectId`, `ProjectSourceKind`, `ProjectSyncState`
- `LibraryFolder`, `LibraryPlacement`
- `SavedProjectMeta`
- `SectionPatch`
- `ProjectPatch` (the typed PATCH body — same shape on both sides of the wire)

Both the frontend `types.ts` and the backend `apps/backend/src/projects/types.ts` re-export from `@shared/projectContract`, so the shared shapes have a single source of truth.

`ProjectSnapshot` is **not** shared. The frontend models it strictly against the rich domain (`LearningPlan`, `ProjectSource`, `PdfDocumentAssets`, …). The backend defines its own permissive JSON-shape `ProjectSnapshot` (`apps/backend/src/projects/types.ts`) because it only shuttles the payload to and from SQLite without inspecting deep fields. The two definitions diverge by design.

If you add or change a field in the rich frontend `ProjectSnapshot`, follow the TypeScript errors to the affected layers. If you add a wire-level field that the backend must understand (typically a new `ProjectPatch` field), edit `packages/shared-types/projectContract.ts` once and both sides pick it up.

Project snapshots may carry legacy fields `laboratory` and `activeLaboratoryExerciseId` inside the raw JSON blob loaded from older storage. These are stripped during `prepareSnapshotForHydration` on the frontend and are not part of the typed surface on either side; if present in inbound payloads they are silently dropped.

## Two AI clients

The frontend uses two distinct AI infrastructures, **on purpose**:

| Client | Used for | Where |
| --- | --- | --- |
| `services/openrouter/` | **Batch pipelines**: one-shot generations (assessment, planning, research, curriculum, lesson content, lesson verification, exercise brief & placement, lesson markdown quality, lesson images, visual examples, document indexing, TTS) | `services/openrouter/` (~30 top-level files) |
| **Vercel AI SDK** (`@ai-sdk/react`, `ai`) | **Interactive chat with tool calls**: Reader Ask-AI panel and Library Home Chat | `components/workspace/shell/ContextAnswerPanel.tsx` and `hooks/library/useLibraryAssistantChat.ts` |

We did not unify because rebuilding the chat/tool-call/history stack on top of `callOpenRouter` would be expensive for low value. The two systems stay separate. The backend exposes both:

- `/api/openrouter/chat/completions` — raw proxy for `services/openrouter/`.
- `/api/chat/context` and `/api/chat/library` — Vercel AI SDK protocol endpoints (streaming + tool calls).

The AI API key is held server-side: the browser never sees it, regardless of which client is making the call.

## Backend

The backend lives in `apps/backend/src/`, with `apps/backend/dist/` used as build output only.

Main entry points:

- `apps/backend/src/server.ts` — reads config, starts the HTTP server, handles shutdown.
- `apps/backend/src/index.ts` — builds the Express app, configures CORS, per-endpoint body limits, auth middleware, and registers routes.

Main entries in `apps/backend/src/routes/`:

- `/api/chat` — chat top-level router that mounts `contextChat` and `libraryChat`.
- `/api/chat/context` (via `contextChat.ts`) — contextual conversation with project-aware AI (Vercel AI SDK protocol).
- `/api/chat/library` (via `libraryChat.ts`) — library assistant chat with tool execution (Vercel AI SDK protocol).
- `/api/openrouter` (via `openRouterProxy.ts`) — raw OpenRouter proxy used by `services/openrouter/`.
- `/api/pdf` — PDF text and image extraction.
- `/api/projects` — auth-gated project repository API used by the frontend server repository.
- `/api/status` — OpenRouter TTS readiness snapshot.
- `/api/tts` — speech generation and model discovery.
- `/api/stt` — authenticated speech transcription through OpenRouter.
- `/api/voices` — voice profiles.
- `chatPrompts.ts` — shared chat prompt construction utilities used by `contextChat.ts` and `libraryChat.ts`.

Supporting modules:

- `apps/backend/src/projects/` — `ProjectStore` interface, `PostgresProjectStore`, legacy `SqliteProjectStore` for dev/test, project meta and sibling-ordering helpers.
- `apps/backend/src/services/` — `pdfTextExtractor` (delegates to `pdftotext`), `pdfImageExtractor`, `ttsClient`, `sttClient`, `voiceService`, `statusService`.
- `apps/backend/src/auth/currentUser.ts` — auth resolution. Supabase is the product path. `LOCAL_AUTH_BYPASS=true` is accepted only in tests or with `LOCAL_DEV_PROFILE=true`.
- `apps/backend/src/config/` — env loading and server config (host, port, backend URL).

### Project Storage

The frontend always uses backend HTTP storage through `services/projects/projectRepositoryFactory.ts`. The backend defaults to `PostgresProjectStore`; `PROJECT_STORAGE_DRIVER=sqlite` is a legacy test/dev driver and is blocked outside `NODE_ENV=test` or `LOCAL_DEV_PROFILE=true`.

The frontend `ProjectRepository` interface and the backend `ProjectStore` interface are currently defined independently in their own files (the contract is **not** type-shared yet). See `docs/architecture-review.md` priority 6.

## TTS

Frontend audio playback calls the backend `/api/tts` route, and that route uses OpenRouter's `audio/speech` endpoint. There is no local TTS runtime in the app flow.

The TTS player in the Reader (`hooks/reader/useTtsPlayer.ts`) splits the lesson content into ~580-character chunks, crossfades them at 35 ms boundaries, and handles seek, skip, and speed changes against the queued audio buffers.

## Speech input

The Library/Home composer and the Reader follow-up composer expose the same microphone control. The first click starts a browser `MediaRecorder`; the second stops it, sends the recording to the authenticated `/api/stt` route, and inserts the returned text into the draft without submitting it.

Browser recordings are capped at 90 seconds. The backend validates the audio format and a 12 MiB decoded payload limit, then calls OpenRouter's dedicated `audio/transcriptions` endpoint. The server-owned model defaults to `nvidia/parakeet-tdt-0.6b-v3` and can be changed with `MODEL_STT`.

Provider details stay in server logs; the frontend receives stable Italian error messages for denied microphone access, empty audio, and transcription failures.

## Where to make changes

| Goal | Files to start with |
| --- | --- |
| Change an AI pipeline prompt | `services/openrouter/` |
| Change a chat (Ask-AI / Library) prompt | `apps/backend/src/routes/chatPrompts.ts` |
| Add or adjust a model slot | `apps/backend/src/config/modelConfig.ts`, `apps/backend/src/routes/admin.ts`, and the `/admin` UI |
| Add a new user operation | `hooks/workspace/controller/`, then `hooks/workspace/useWorkspaceReaderActions.ts` |
| Add a field to the rich project model | `apps/web/types.ts` (frontend domain `ProjectSnapshot`), then follow the compiler errors. If the field also crosses the wire (e.g. it must survive a PATCH), add it to `packages/shared-types/projectContract.ts` and the backend `ProjectSnapshot` in `apps/backend/src/projects/types.ts` |
| Add a field to the FE↔BE wire contract | `packages/shared-types/projectContract.ts` — both sides pick it up via the `@shared/*` alias |
| Change reader layout or behavior | `components/workspace/` and `hooks/workspace/useWorkspaceReaderState.ts` |
| Add a new UI element with state | `hooks/workspace/useWorkspaceReaderState.ts` plus a component in `components/workspace/` |
| Change sidebar click behavior | `hooks/workspace/useWorkspaceReaderActions.ts` |
| Modify project persistence | `services/projects/` and `hooks/library/useProjectLibrary.ts` |
| Change how screen transitions work | `hooks/workspace/useWorkspaceNavigation.ts` |
| Adjust the library assistant | `hooks/library/useLibraryAssistantChat.ts`, `services/library/toolExecutor.ts`, and `apps/backend/src/routes/libraryChat.ts` |
| Change application-exercise placement or generation | `services/exercises/plan.ts` (pure logic) + `services/openrouter/exercises/placement.ts` and `services/openrouter/exercises/brief.ts` (AI side) |
| Change auth or CORS | `apps/backend/src/auth/currentUser.ts` and `apps/backend/src/index.ts` |

## Architectural rules

- Services do not import React hooks.
- Components should not call services directly when a hook can own the side effect.
- The domain should not depend on the current screen or visual state.
- Each hook should stay inside one responsibility area.
- AI pipelines (batch) go through `services/openrouter/`. Interactive chats with tool calls go through Vercel AI SDK. Do not mix the two stacks in a single feature.
- All AI calls go through the backend proxy. The browser must never receive the AI API key.
- `apps/backend/dist/` should not be edited directly.

## Tooling

```bash
bun run dev       # Frontend + backend in watch mode
bun run quality   # TypeScript type check + Biome lint
bun run fix       # Auto-fix Biome lint, format, and import ordering
bun run gate      # Full gate: quality + fallow + tests
bun run test      # Vitest test suite (runs under Bun runtime)
```
