# Nous Reader Architecture

This document is the technical source of truth for how Nous Reader is organized, its domain
language, and where to make changes. Product and design direction lives in the
[manifesto](https://github.com/immagiov4/Lumina-Reader/discussions/33); production operations live in
[DEPLOYMENT.md](DEPLOYMENT.md).

## What Nous Reader does

Nous Reader takes one or more document sources (typically PDF, Markdown, or text) and generates a personalized study flow: onboarding chat, study plan, lessons, quizzes, and application exercises that are intercalated between lessons in the path and evaluated by AI.

Course, lesson, and generated-visual pipelines run as durable backend workflows. Interactive chats use the Vercel AI SDK, while the remaining bounded AI operations use authenticated backend endpoints. The backend also extracts text and images from PDFs, validates Supabase Auth sessions, persists projects and generated assets, and provides TTS.

## Runtime pieces

The application is made of two separate runtimes:

| Piece | Default port | Purpose |
| --- | --- | --- |
| Frontend (`apps/web/`) | 5173 | React UI, interaction state, and HTTP clients for backend operations |
| Backend (`apps/backend/`) | 3301 | API server, durable AI workflows, PDF extraction, project and asset storage, admin routes, and TTS |

`packages/shared-types/` holds shared contracts and deterministic wire codecs used by both (see
[Domain and wire types](#9-domain-and-wire-types)). It must remain independent from either app.

```text
Browser -> static frontend -> Bun backend -> Supabase Auth/Postgres
                                  |-------> OpenRouter
```

Local development runs both application processes through Bun and the Supabase CLI stack through Docker. Production runs the same frontend/backend boundaries through `compose.yml`; Supabase is either managed or the separately maintained official self-hosted Docker stack. See [DEPLOYMENT.md](DEPLOYMENT.md).

## Frontend entry point

`apps/web/App.tsx` owns the authentication gate and lazy route split between the admin panel and the reader. `apps/web/app/AppContent.tsx` is the reader composition root: it wires together the domain, controller, reader state, navigation, file actions, and library chat, then chooses one of four screens based on `screenState`:

- Library
- Assessment
- Planning
- Reading

The screen switch itself is simple; `AppContent.tsx` owns the shared hook composition and passes navigation, file-action, and dialog adapters into the screen containers.

## Frontend layers

Think of the frontend as a set of concentric layers.

### 1. Services

`services/` contains plain TypeScript modules. They should not import React hooks.

Important subfolders:

- `services/openrouter/` — authenticated clients for bounded AI operations. Durable course
  interviews, course and lesson generation, visual retries, artifact drafts, and PDF mapping repair
  are owned by backend workflows instead.
- `services/exercises/` — application-exercise domain: pure plan operations (`plan.ts`), constants, and deliverable handling (attachments + zip).
- `services/learning/` — pure functions on the learning plan that are not exercise-specific: sub-chapter grouping and legacy migration for old "mini-lab" lessons.
- `services/projects/` — `ProjectRepository` interface, HTTP adapter, authenticated revision stream, server-only repository factory, project snapshot helpers, archives, persistence signatures, and sync state.
- `services/workspace/` — domain reducer (`domain.ts`), persistence helpers, workflow selectors, and pure controller logic under `controller/` (`documentAssets.ts`, `learnMode.ts`, `snapshotHydration.ts`).
- `services/library/` — library assistant tool execution.
- `services/preferences/` — UI preference persistence and library folder expansion storage.
- `services/audio/` — voice profile definitions and helpers.
- `services/core/` — shared utilities such as tracing and error normalization.

### 2. Domain

The workspace domain lives in `services/workspace/domain.ts` and is exposed through `hooks/workspace/useWorkspaceDomain.ts`.

This is the source of truth for the current project payload:

- logical source set with per-source identity, outline, processing state, and document index
- learning plan (modules → lessons + application exercises intercalated)
- PDF assets and document index
- learner profile and syllabus
- research course plan and per-section research dossiers (used by research mode)
- active section id
- learn mode flag

`ProjectSource.sources` is the authoritative logical source set for document-backed courses. The root
file identifies the primary source; it is not a physical merge of the set. Planning receives the
source outlines and bounded content samples, while lesson generation retrieves only the chunks
mapped to that lesson. Chunk ids and lesson source references retain their `sourceId`, plus page
ranges where available.

It should not know anything about the screen the user is on.

Application exercises live inside `learningPlan.modules[].children` as `PathNode` entries with `kind: 'exercise'`, intercalated with lessons. There is no separate laboratory state. See [Domain and wire types](#9-domain-and-wire-types).

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
- `hooks/library/useLibraryAssistantChat.ts` — library assistant chat (Vercel AI SDK; see [AI execution paths](#ai-execution-paths)).
- `hooks/library/usePersistedLibraryFolderExpansion.ts` — which folders are expanded (localStorage).

### 8. UI components

`components/` should stay rendering-focused.

- `components/library/` — library screen, project cards, folder tree (drag & drop), home chat panel.
- `components/assessment/` — onboarding screen.
- `components/workspace/` — reader shell, header, sidebar, content, audio player, context menu, ask-AI panel, overlays.
- `components/shared/` — loading screen, markdown rendering, reader settings panel, shared UI.

Components should not call services directly when a hook can own the behavior instead.

### 9. Domain and wire types

The relevant type boundaries are:

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

**`packages/shared-types/projectContract.ts`** holds shared project identifiers, metadata, revision
events, write preconditions, and PATCH shapes. **`packages/shared-types/projectSnapshotWire.ts`** is
the canonical, versioned full-snapshot wire format used by normal saves, imports, exports, and
backups.

- `ProjectId`, `ProjectSourceKind`
- `LibraryFolder`, `LibraryPlacement`
- `SavedProjectMeta`, `ProjectRevisionEvent`, `ProjectWriteOptions`
- `SectionPatch`
- `ProjectPatch` (the typed PATCH body — same shape on both sides of the wire)

The frontend keeps a richer hydrated `ProjectSnapshot`; the backend keeps its persistence shape.
Both must cross the boundary through the shared wire decoder and encoder. Canonical payloads reject
unknown or malformed fields. Legacy payloads explicitly discard the obsolete `laboratory` and
`activeLaboratoryExerciseId` fields and quarantine other unmapped values in
`legacyUnmappedFields` so migrations do not silently lose data.

Use **lesson** for a `LessonNode` and **path node** for a lesson-or-exercise union. Do not introduce
the deprecated **laboratory**, **mini-lab**, or `section` terminology in new domain code; `section`
remains only in established identifiers and legacy shapes.

## AI execution paths

Nous Reader deliberately separates durable generation from interactive chat:

| Path | Used for | Where |
| --- | --- | --- |
| Durable workflow runtime | Course interviews and planning, lesson generation, PDF mapping repair, generated visuals, artifact drafts, retries, cancellation, signals, undo, and durable events | `apps/backend/src/workflows/`, exposed through workflow-specific routes |
| Authenticated bounded requests | Application-exercise operations, contextual research, images, speech, and other single-request work | frontend service adapters plus backend routes/services |
| **Vercel AI SDK** (`@ai-sdk/react`, `ai`) | **Interactive chat with tool calls**: Reader Ask-AI panel and Library Home Chat | `components/workspace/shell/ContextAnswerPanel.tsx` and `hooks/library/useLibraryAssistantChat.ts` |

Interactive chat stays separate because its streaming history and tool-call contract differs from a durable background workflow. The backend exposes:

- `/api/course-interviews`, `/api/course-workflows` (including PDF mapping repair),
  `/api/lesson-workflows`, `/api/artifact-drafts`, and the project-scoped visual retry endpoint —
  durable generation entry points.
- `/api/workflows` — shared workflow state, cancellation, and signal operations.
- `/api/openrouter/chat/completions` — authenticated proxy for remaining bounded calls.
- `/api/chat/context` and `/api/chat/library` — Vercel AI SDK protocol endpoints (streaming + tool calls).

Reader context chat sends original document provenance as structured source references (file name,
stable source ID, page range, and chunk IDs). The combined text is only request context: the UI and
prompt must never present it as a merged document, and document links resolve to the original file.

### Durable workflow runtime

Workflow definitions are compositions of typed primitives registered and validated at backend
startup. Registration rejects invalid graphs before work can begin. Each run stores its definition
identifier, structural hash, model/configuration snapshot, node state, attempts, signals, waits,
outbox events, undo state, and AI usage in PostgreSQL; `generation_jobs` is not a runtime fallback.

The deployment manifest is activated atomically for the whole registry. For each workflow it names
one current definition and a bounded set of older definitions allowed to drain; PostgreSQL keeps
only the current and immediately previous manifest to classify rolling replicas. A monotonic
workflow-set version changes only when a production registry adds or removes an entire workflow ID;
definition hashes and resumable-definition lineage continue to handle changes within a workflow.
The version orders otherwise ambiguous complete manifests, so an old replica cannot interpret a
newly added workflow as an intentional removal. New runs may start only on the current definition.
Claims, expired-lease recovery, signals, step checkpoints/failures, and undo completions/failures
lock and verify the authoritative manifest in the same transaction, so a stale replica cannot run
or commit a definition removed by the new deployment. Removing a definition is also the explicit
kill switch: active runs using it are terminalized, their leases are fenced, and any unavailable
cleanup is recorded for operator intervention instead of executing code from the removed
definition.

Workers claim nodes with leases and heartbeats, persist every transition before exposing it, and
recover expired work after a crash. A failed workflow walks completed side-effecting nodes in
reverse order and records every undo attempt; a no-op repeated undo does not publish another
project revision. Cancellation uses the same durable terminal path and also aborts provider work
when the provider supports it.

Committed project revisions leave the workflow transaction through the **coda durevole delle
notifiche**, implemented with a transactional outbox and an idempotent recipient inbox. Delivery
records the PostgreSQL inbox entry before `LISTEN`/`NOTIFY` wakes every backend replica, which fans
the revision out to its local authenticated SSE clients. Because PostgreSQL notifications
themselves are ephemeral, a listener reconnect or notification-read failure emits a resync event:
browsers then compare authoritative project revisions rather than trusting the missed notification
history.

The AI API key is held server-side: the browser never sees it, regardless of which client is making the call.

Text and image backends are resolved per model function. The global configuration chooses a default
provider and may override the semantic workload slots independently:

- `course` owns course planning, source-backed structuring, document mapping, and exercise placement;
- `lesson` owns lesson dossier structuring, drafting, repair, quizzes, learning aids, and final verification;
- `research` owns web and YouTube discovery, source coverage, and source analysis;
- `context` is reserved for contextual and library chat;
- `assessment`, `progress`, `artifact`, `artifactInteractive`, and `image` retain their dedicated roles.

These slots describe product responsibilities, not transient generation phases. A request without
an explicit valid slot is rejected; the backend does not infer or rewrite ownership from the
selected provider. User metadata may replace the global default and then override individual slots
again. The backend performs this resolution
authoritatively for every request, so the browser cannot select a provider by changing a model name.
The admin UI exposes the same hierarchy through compact expandable provider panels.

OpenRouter and OpenAI use server-owned credentials. The optional self-hosted Codex adapter talks to
one pinned `codex app-server` child over stdio; Nous never reads its credential files. The child
inherits an allowlisted environment and receives only request-scoped tools: shell, filesystem,
browser, apps, plugins, MCP, and workspace capabilities are not exposed. Missing or unavailable
providers fail explicitly rather than silently switching quota.

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
- `/api/course-interviews`, `/api/course-workflows` (including `/pdf-mapping-repairs`),
  `/api/lesson-workflows`, `/api/artifact-drafts`, and
  `/api/projects/:projectId/sections/:sectionId/visuals/:slotId/retry` — start durable product
  workflows.
- `/api/workflows` — read common workflow state, request cancellation, and deliver typed one-use signals.
- `/api/pdf` — PDF text and image extraction.
- `/api/projects` — auth-gated project repository API used by the frontend server repository.
- `/api/status` — OpenRouter TTS readiness snapshot.
- `/api/tts` — speech generation and model discovery.
- `/api/stt` — authenticated speech transcription through OpenRouter.
- `/api/voices` — voice profiles.
- `chatPrompts.ts` — shared chat prompt construction utilities used by `contextChat.ts` and `libraryChat.ts`.

Supporting modules:

- `apps/backend/src/workflows/` — typed workflow primitives, registration validation, PostgreSQL
  persistence, worker/recovery loops, and the interview, course, lesson, PDF-repair, visual, and
  artifact workflow definitions.
- `apps/backend/src/projects/` — `ProjectStore` interface, runtime `PostgresProjectStore`, project patching, generated-asset persistence, and metadata helpers.
- `apps/backend/src/services/` — `pdfTextExtractor` (delegates to `pdftotext`), `pdfImageExtractor`, `ttsClient`, `sttClient`, `voiceService`, `statusService`.
- `apps/backend/src/auth/currentUser.ts` — auth resolution. Supabase is the product path. `LOCAL_AUTH_BYPASS=true` is accepted only in tests or with `LOCAL_DEV_PROFILE=true`.
- `apps/backend/src/config/` — env loading and server config (host, port, backend URL).

### Project Storage

The frontend always uses backend HTTP storage through `HttpProjectRepository`. The backend always creates `PostgresProjectStore`; there is no runtime storage-mode switch. Backend route tests exercise the persistence contract through a dedicated in-memory `ProjectStore`, without carrying a second production-style database implementation.

The frontend `ProjectRepository` and backend `ProjectStore` interfaces remain separate adapters,
while their wire-level values use the shared contracts and codecs described in
[Domain and wire types](#9-domain-and-wire-types).

Project-source bytes live only in the private Supabase Storage bucket `project-sources`. Postgres
stores the primary reference in `project_sources`, every logical source descriptor in
`project_source_files`, and ZIP entry metadata in `project_source_entries`. Runtime snapshots contain
only immutable references and empty `file.data` fields: there is no persistent Base64, concatenated
code bundle, alternate filesystem store, or post-cutover fallback. Creating a new source-backed
project is one application write: Storage uploads are verified first, project and source metadata are
committed together, and a failed database write removes the uploaded objects.

Project backup archives currently use `archiveVersion: 2`. A persisted `youtubeTranscript` contains
only `segments`, where every segment has `startSeconds`, `endSeconds`, and `text`. Timestamped model
text, clip bounds, and diagnostics are derived from those segments; formatted text is not a second
source of truth. Version 1 archives may contain the historical parallel `text` and `ranges` fields:
the import boundary normalizes them immediately to segments, and every subsequent export emits only
the version 2 representation.

### Large source archives

ZIP sources are indexed as archives rather than flattened text. The backend preserves the original
ZIP and every entry, validates exact paths and duplicate records, and rejects archives above the
named safety limits: 20,000 entries, 256 MB for one expanded file, or 1 GB total expanded content.
The browser treats a source ZIP as opaque bytes and sends the original `File` in a binary multipart
project PUT; it never reads, Base64-encodes, or embeds the archive in JSON. The response returns the
authoritative detached index, which is the only index used for assessment and planning.
The backend expands one file at a time, checks the bytes actually produced before accepting them,
and bounds concurrent Storage uploads before opening the short metadata transaction.
The persisted index contains the complete directory/file structure, byte sizes, content kind, and
the first 24 lines of every UTF-8 text file, capped at 8,000 characters per preview. Binary files
remain addressable metadata but are never decoded as lesson text.

Course planning receives the complete index and shares a global 180,000-character preview budget
equally across all textual files in stable path order. It never eagerly concatenates complete
documentation into the prompt. Every textual file remains addressable through exact tools to list a
directory, search a literal string, obtain the full tree, or read successive UTF-8 pages of at most
256 KiB using the returned byte cursor. Page reads use authenticated Supabase Storage byte ranges
and fail if Storage ignores or misreports the requested range; there is no full-object fallback.
The local tool loop also fails explicitly before another model request once serialized tool results
exceed 8 MiB. Every index response includes its immutable source ID and hash; all later tool calls
must present that version, and stale calls fail with HTTP 409 rather than mixing two archive
versions. The planner must assign at least one exact file or directory selector to every lesson. A
lesson resolves those selectors before generation: file selectors load that complete text file,
while directory selectors load every textual descendant and skip indexed binaries. The selected
lesson context is all-or-nothing and fails explicitly above 4 MB instead of silently dropping files.

The archive planner and lesson generator request OpenRouter's `middle-out` transform for oversized
prompts; the Codex adapter uses its native context handling. This compression is a provider concern,
not a substitute for the index and exact source tools. Source-backed course planning also performs
supplemental web and transcript-backed YouTube research, and lesson dossier generation performs its
own web and YouTube pass. Original material stays primary; online research fills gaps and supplies
current references.

Every project metadata response includes the server-owned monotonic `revision`. Existing-project PUT and PATCH requests send `expectedRevision`; a stale request receives HTTP 409 and never updates the snapshot. Authenticated server-sent events at `/api/projects/events` carry project revisions or a payload-free resync request after a backend listener reconnect. `useProjectLibrary` refreshes metadata on either event, browser reconnect, foreground, or network recovery, and reloads the active snapshot only when the revision advanced and no local write or dirty autosave state is pending.

`GET /api/projects/covers/regenerate` starts or resumes a non-cacheable background job for every course owned by the authenticated user and returns immediately. `GET /api/projects/covers/regenerate/status` reads that user's current job without starting one, so the admin UI can safely restore and poll progress. Jobs use an in-memory per-user registry with a 15-minute completed cooldown and a fair per-user scheduler capped at four global operations. A backend restart loses job status and cooldown, but persisted covers remain intact.

The configured provider must produce a valid visual direction before image generation; planning failure does not overwrite a good cover. Before saving, the backend rechecks the project title and timestamp and performs an atomic expected-revision write. Deleted, renamed, or concurrently updated projects are reported as `skipped`; provider failures are `failed`. Raw provider output is stored with its prompt version and is normalized to the frontend's optimized WebP storage version on first display.

## TTS

Frontend audio playback calls the backend `/api/tts` route, and that route uses OpenRouter's `audio/speech` endpoint. There is no local TTS runtime in the app flow.

The TTS player in the Reader (`hooks/reader/useTtsPlayer.ts`) splits the lesson content into ~580-character chunks, crossfades them at 35 ms boundaries, and handles seek, skip, and speed changes against the queued audio buffers.

## Speech input

The Library/Home composer and the Reader follow-up composer expose the same microphone control. The first click starts a browser `MediaRecorder`; the second stops it, sends the recording to the authenticated `/api/stt` route, and inserts the returned text into the draft without submitting it.

Browser recordings are capped at 90 seconds. The backend validates the audio format and a 12 MiB decoded payload limit, then calls OpenRouter's dedicated `audio/transcriptions` endpoint. It retries with server-owned timeouts of 20, 25, and 30 seconds; the first two attempts use `MODEL_STT` (default `nvidia/parakeet-tdt-0.6b-v3`) and the final attempt uses `MODEL_STT_FALLBACK` (default `openai/whisper-large-v3-turbo`).

Provider details stay in server logs; the frontend receives stable Italian error messages for denied microphone access, empty audio, and transcription failures.

## Generated visual artifacts

The visual planner can select `illustrative_image` only for concrete appearance, texture, physical objects, organisms, places, historical scenes, or natural phenomena where a schematic representation would lose essential information. Processes, structures, comparisons, and quantitative data continue to use SVG, Mermaid, or interactive HTML.

The frontend sends the pedagogical image prompt to the authenticated `/api/images/generate` route. The backend calls OpenRouter's dedicated `/images` endpoint with a server-owned model, defaulting to `google/gemini-3.1-flash-lite-image` and configurable through `MODEL_IMAGE`. Only PNG, JPEG, and WebP base64 responses are accepted and persisted; generated raster data URLs are never embedded in later LLM revision prompts.

SVG, Mermaid, and interactive HTML render through `GeneratedVisualFrame`. Mermaid is bundled
locally and rendered in strict mode. Generated HTML runs in a sandboxed iframe with scripts but no
same-origin privilege; its CSP blocks external resources, network connections, forms, workers,
plugins, and nested frames. Inline interaction remains allowed deliberately, so visual-generation
prompts must restrict output to educational, non-destructive behavior.

Course cover generation uses the shared versioned prompt in `packages/shared-types/courseCoverPrompt.ts` from both the automatic frontend flow and the authenticated backend batch route. This keeps provider planning, fallback direction, and image instructions aligned across new courses and operator-triggered regeneration.

## Where to make changes

| Goal | Files to start with |
| --- | --- |
| Change a durable interview, course, lesson, PDF-repair, visual, or artifact prompt | the owning module in `apps/backend/src/workflows/` or `apps/backend/src/services/` |
| Change a bounded frontend AI operation | the owning adapter in `apps/web/services/openrouter/` |
| Change a chat (Ask-AI / Library) prompt | `apps/backend/src/routes/chatPrompts.ts` |
| Add or adjust a model slot | `apps/backend/src/config/modelConfig.ts`, `apps/backend/src/routes/admin.ts`, and the `/admin` UI |
| Add a new user operation | `hooks/workspace/controller/`, then `hooks/workspace/useWorkspaceReaderActions.ts` |
| Add a field to the rich project model | `apps/web/types.ts`, then follow the compiler errors through hydration and persistence |
| Add a field to a project PATCH | `packages/shared-types/projectContract.ts` |
| Add a field to a complete saved/imported/exported snapshot | `packages/shared-types/projectSnapshotWire.ts`, then the frontend and backend domain adapters |
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
- Multi-step interviews, course and lesson generation, PDF repair, visuals, and artifact generation go
  through the durable backend workflow runtime. Interactive chats with tool calls use the Vercel AI
  SDK. Keep single-request adapters outside the workflow runtime.
- All AI calls go through the backend proxy. The browser must never receive the AI API key.
- `apps/backend/dist/` should not be edited directly.

## Tooling

Bun is the JavaScript package manager and task runner, and the root workspace owns the single
lockfile for the frontend and backend. The quality gate uses `uvx` only to execute the pinned
Semgrep CLI.

Use `bun run dev` for the local stack, `bun run gate` for routine validation, and
`bun run gate:full` after a non-trivial batch. The canonical check list and CI contract live in
[Testing and quality gates](TESTING.md).
