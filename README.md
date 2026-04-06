# Lumina Reader

AI-powered deep reading and learning platform. Upload documents (PDF, plain text, code archives) and Lumina generates personalized study plans, interactive lessons, and assessments using LLMs via OpenRouter.

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

This launches the Vite frontend at `http://localhost:5173` and the Express backend at `http://localhost:3001`.

## Quality

```bash
npm run quality   # TypeScript type checks (frontend + backend) + Biome lint
npm test          # Vitest test suite
```

## Code Map

- `App.tsx` — top-level screen shell (library, assessment, planning, reading modes)
- `hooks/workspace/useWorkspaceController.ts` — public entry point for app workflows
- `hooks/workspace/controller/` — assessment/planning flow, project lifecycle, section progression
- `hooks/library/useProjectLibrary.ts` — IndexedDB-backed project repository + autosave
- `services/openrouter/` — AI integrations and prompt orchestration
- `backend/src/` — backend source; `backend/dist/` is build output
