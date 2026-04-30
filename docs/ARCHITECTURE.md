# Nous Reader Architecture

This document explains how Nous Reader is organized and where to make changes.

## What Nous Reader Does

Nous Reader takes a document source, then generates a personalized study flow: onboarding chat, study plan, lessons, quizzes, and a laboratory phase with AI-evaluated exercises.

AI generation is centered in the frontend code under `services/openrouter/`, while the backend provides supporting API routes for chat, PDF extraction, project storage, and TTS.

## Runtime Pieces

The application is made of two separate runtimes:

| Piece | Default port | Purpose |
| --- | --- | --- |
| Frontend | 5173 | React UI and most client-side orchestration |
| Backend | 3301 | API server for chat, PDF, projects, and TTS |

## Frontend Entry Point

`App.tsx` is the composition root. It wires together the domain, controller, reader runtime, navigation, file actions, and library chat, then chooses one of four screens based on `screenState`:

- Library
- Assessment
- Planning
- Reading

The screen switch itself is simple, but `App.tsx` still coordinates a few cross-cutting behaviors such as project auto-opening, the course-generation notes dialog, and top-level file inputs.

## Frontend Layers

Think of the frontend as a set of concentric layers.

### 1. Services

`services/` contains plain TypeScript modules. They should not import React hooks.

Important subfolders:

- `services/openrouter/` - OpenRouter clients, prompt builders, model selection, TTS requests, lesson generation, assessment, planning, curriculum, laboratory, PDF indexing
- `services/audio/` - audio helpers and voice profile definitions
- `services/library/` - library assistant tool execution
- `services/projects/` - project repositories, snapshots, archives, transfer helpers, import/export
- `services/workspace/` - domain reducer, persistence helpers, workflow selectors
- `services/preferences/` - UI preference persistence and library folder expansion storage
- `services/core/` - shared utilities such as tracing and error normalization

### 2. Domain

The workspace domain lives in `services/workspace/domain.ts` and is exposed through `hooks/workspace/useWorkspaceDomain.ts`.

This is the source of truth for the current project payload:

- source document
- learning plan
- laboratory state
- PDF assets and index
- learner profile
- syllabus
- active section and active laboratory exercise

It should not know anything about the screen the user is on.

### 3. Controller

`hooks/workspace/useWorkspaceController.ts` is the public entry point for workspace behavior. The real logic is split across `hooks/workspace/controller/`.

Relevant controller modules:

- `assessmentPlanning.ts` - onboarding chat and study-plan creation
- `sectionProgression.ts` - opening, completing, regenerating, and progressing through sections
- `laboratory.ts` - laboratory generation, attachment handling, and AI evaluation
- `projectLifecycle.ts` - create, open, save, delete, export
- `projectImport.ts` - import from JSON
- `state.ts` - controller state model

If you are adding a new user-visible operation, it usually belongs here.

### 4. Reader Runtime

`hooks/workspace/useWorkspaceReaderRuntime.ts` holds visual state, not project state:

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

### 5. Reader Actions

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

### 7. Library Hooks

The library has its own small subsystem:

- `hooks/library/useProjectLibrary.ts` - project repository, folders, autosave, LAN transfer, import/export
- `hooks/library/useLibraryAssistantChat.ts` - the library assistant chat powered by the backend chat route

### 8. UI Components

`components/` should stay rendering-focused.

- `components/library/` - library screen, project cards, folder tree, assistant chat
- `components/assessment/` - onboarding screen
- `components/workspace/` - reader shell, header, sidebar, laboratory, overlays, audio player, context menu
- `components/shared/` - loading screen, markdown rendering, model settings panel, shared UI

Components should not call services directly when a hook can own the behavior instead.

### 9. Shared Types

`types.ts` holds the shared contract for the app, including:

- `AppState`
- `ProjectSnapshot`
- `LearningPlan`
- `LearningSection`
- `LaboratoryState`
- `UiPreferences`
- `LibraryTree`
- PDF source and index types

If you add or change a field here, follow the TypeScript errors to the affected layers.

## Backend

The backend lives in `apps/backend/src/`, with `apps/backend/dist/` used as build output only.

Main entry points:

- `apps/backend/src/server.ts` - reads config, starts the HTTP server, handles shutdown
- `apps/backend/src/index.ts` - builds the Express app and registers routes

Main routes:

- `/api/chat` - chat proxy routes for the library assistant and contextual chat
- `/api/pdf` - PDF text and image extraction
- `/api/projects` - project repository API used by LAN sync mode
- `/api/status` - OpenRouter TTS readiness snapshot
- `/api/tts` - speech generation and model discovery
- `/api/voices` - voice profiles

The backend uses SQLite for project storage in LAN mode. The frontend chooses between browser IndexedDB and backend HTTP storage through `services/projects/projectRepositoryFactory.ts`.

## TTS

Frontend audio playback calls the backend `/api/tts` route, and that route uses OpenRouter's `audio/speech` endpoint. There is no local TTS runtime in the app flow.

## Where To Make Changes

| Goal | Files to start with |
| --- | --- |
| Change an AI prompt | `services/openrouter/` |
| Add or adjust a model slot | `services/openrouter/config.ts`, `components/workspace/`, `components/library/` |
| Add a new user operation | `hooks/workspace/controller/`, then `hooks/workspace/useWorkspaceReaderActions.ts` |
| Add a field to the project model | `types.ts`, then follow the compiler errors |
| Change reader layout or behavior | `components/workspace/` and `hooks/workspace/useWorkspaceReaderRuntime.ts` |
| Add a new UI element with state | `hooks/workspace/useWorkspaceReaderRuntime.ts` plus a component in `components/workspace/` |
| Change sidebar click behavior | `hooks/workspace/useWorkspaceReaderActions.ts` |
| Modify project persistence | `services/projects/` and `hooks/library/useProjectLibrary.ts` |
| Change how screen transitions work | `hooks/workspace/useWorkspaceNavigation.ts` |
| Adjust the library assistant | `hooks/library/useLibraryAssistantChat.ts` and `apps/backend/src/routes/libraryChat.ts` |

## Architectural Rules

- Services do not import React hooks.
- Components should not call services directly when a hook can own the side effect.
- The domain should not depend on the current screen or visual state.
- Each hook should stay inside one responsibility area.
- `apps/backend/dist/` should not be edited directly.

## Tooling

```bash
npm run dev       # Frontend + backend in watch mode
npm run quality   # TypeScript type check + Biome lint
npm test          # Vitest test suite
```
