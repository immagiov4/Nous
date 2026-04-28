# Nous Reader

Nous Reader turns uploaded documents into personalized study plans with lessons, quizzes, and laboratory exercises backed by AI feedback.

## Start Here

- [AI instructions](AI_INSTRUCTIONS.md)
- [Architecture guide](docs/ARCHITECTURE.md)
- [Optional local TTS server](docs/TTS_SETUP.md)
- [UI style guide](docs/UI_STYLE_GUIDE.md)

## Run Locally

1. Install the frontend dependencies:
   ```bash
   npm ci
   ```
2. Install the backend dependencies:
   ```bash
   cd apps/backend && npm ci && cd ../..
   ```
3. Set `OPENROUTER_API_KEY` in [.env.local](.env.local)
4. Start the app:
   ```bash
   npm run dev
   ```

This starts the Vite frontend on `http://localhost:5173` and the Express backend on `http://localhost:3301`.

## What Lives Where

- Frontend app: `apps/web/`
- Backend API server: `apps/backend/src/`
- Optional standalone Python TTS service: `services/tts-server/`
- Tooling scripts: `tooling/scripts/`
- Documentation: `docs/`

By default, projects are stored in browser IndexedDB. LAN sync uses the backend SQLite store when repository mode is set to `lan`.

## Useful Commands

```bash
npm run quality   # TypeScript type checks + Biome lint
npm test          # Vitest test suite
npm run dev:tts   # Optional standalone Qwen3-TTS server
```
