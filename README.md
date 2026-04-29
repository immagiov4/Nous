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

## LAN Development

Use LAN mode when another device on the same private network must read and write the shared backend project store.

1. Bind the backend and frontend to the network:
   - `server.config.json`: set `backendHost` to `0.0.0.0`
   - `apps/web/vite.config.ts`: keep `server.host` set to `0.0.0.0`
2. Enable the LAN repository in `.env.local`:
   ```env
   PROJECT_REPOSITORY_MODE=lan
   VITE_PROJECT_REPOSITORY_MODE=lan
   LOCAL_AUTH_BYPASS=true
   CORS_ALLOW_PRIVATE_NETWORK=true
   ```
3. Open the app from the other device with the host machine IP, for example `http://192.168.1.10:5173`.
4. Restart the dev server after changing `.env.local`; backend auth and CORS flags are loaded at startup.

`LOCAL_AUTH_BYPASS=true` is for local development only. Do not enable it in a deployment without a real authentication layer. `CORS_ALLOW_PRIVATE_NETWORK=true` only admits private-network frontend origins on port `5173`; production origins should be listed explicitly with `CORS_ALLOWED_ORIGINS`.

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
