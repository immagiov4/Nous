# Nous Reader

AI-powered deep reading and learning platform. Upload documents (PDF, plain text, code archives) and Nous generates personalized study plans, interactive lessons, assessments, and a separate laboratory phase with attachment-based practical exercises and AI feedback.

## Architecture

- **Frontend** — React 19 + TypeScript + Vite (repo root: `App.tsx`, `components/`, `hooks/`, `services/`)
- **Backend** — Express.js + TypeScript (`backend/src/`), primarily a TTS control plane and proxy
- **TTS server** (optional) — Python FastAPI Qwen3-TTS service (`tts-server/`); see [TTS_SETUP.md](TTS_SETUP.md)

## Prerequisites

- Node.js 22+
- npm

## Run Locally

1. Install frontend dependencies:
   ```bash
   npm ci
   ```
2. Install backend dependencies:
   ```bash
   cd backend && npm ci && cd ..
   ```
3. Set the `OPENROUTER_API_KEY` in [.env.local](.env.local)
4. Start the app:
   ```bash
   npm run dev
   ```

This launches the Vite frontend at `http://localhost:5173` and the Express backend at `http://localhost:3301`.

## LAN Project Sync

Projects are browser-local by default. To share the same project library across devices on your
local network, run the frontend/backend on a host reachable from the LAN and set:

```bash
PROJECT_REPOSITORY_MODE=lan
VITE_PROJECT_REPOSITORY_MODE=lan
PROJECT_STORAGE_DRIVER=sqlite
PROJECT_SQLITE_PATH=./data/lumina-projects.sqlite
LOCAL_AUTH_BYPASS=true
LOCAL_USER_ID=local-user
```

In this mode the Express backend stores projects in a local SQLite file and all LAN clients use the
same built-in user. There is no device discovery in v1: open the app from the other device using the
server machine IP/hostname, for example `http://192.168.1.10:5173`.

## Quality

```bash
npm run quality   # TypeScript type checks (frontend + backend) + Biome lint
npm test          # Vitest test suite
```

## Code Map

- `App.tsx` — top-level screen shell (library, assessment, planning, reading modes)
- `hooks/workspace/useWorkspaceController.ts` — public entry point for app workflows
- `hooks/workspace/controller/` — assessment/planning flow, project lifecycle, section progression
- `hooks/workspace/controller/laboratory.ts` — laboratory generation, exercise selection, attachment editing, evaluation
- `hooks/library/useProjectLibrary.ts` — IndexedDB-backed project repository + autosave
- `services/laboratory/` — generic laboratory attachment and state helpers
- `services/openrouter/` — AI integrations and prompt orchestration
- `backend/src/` — backend source; `backend/dist/` is build output
