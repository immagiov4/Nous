# Nous Reader

Nous Reader turns uploaded documents and researched topics into personalized courses with lessons, reflection prompts, and application exercises backed by AI feedback.

## Start Here

- [AI instructions](AGENTS.md)
- [Domain glossary](CONTEXT.md)
- [Architecture guide](docs/ARCHITECTURE.md)
- [Architecture audit](docs/ARCHITECTURE_AUDIT.md)
- [Production deployment](docs/DEPLOYMENT.md)
- [OpenAI and Codex providers](docs/OPENAI_PROVIDER_SPIKE.md)
- [UI style guide](docs/UI_STYLE_GUIDE.md)

## Run Locally

1. Install the Bun workspace dependencies:
   ```bash
   bun install
   ```
2. Copy [.env.example](.env.example) to `.env.local` and set the local Supabase keys plus `OPENROUTER_API_KEY`. `OPENAI_API_KEY` is optional.
3. Start the app:
   ```bash
   bun run dev
   ```

This starts the Vite frontend on `http://localhost:5173` and the Express backend on `http://localhost:3301`.

When the configured Supabase or Postgres URL points to the local machine, `bun run dev` also verifies Docker, starts Docker Desktop on Windows or macOS when needed, starts the local Supabase stack, and checks Supabase Auth before launching the app. If those services cannot start, the command exits instead of leaving a frontend without its backend. Remote-only configurations skip this local infrastructure check.

To use a local ChatGPT/Codex account without copying its credentials into Nous, install Codex CLI, then set `CODEX_APP_SERVER_ENABLED=true` and `CODEX_OWNER_USER_ID` to the sole Nous user allowed to use it. The backend accepts Codex requests only from that user over a loopback connection. The account area starts the official device-code flow through `codex app-server`; hosted/shared deployments leave this mode disabled.

## Server-Only Storage

Nous now uses authenticated server storage as the product path.

- Project storage is Postgres and requires `DATABASE_URL`.
- Frontend auth should use `VITE_AUTH_MODE=supabase`.
- Development can use `AUTH_MODE=local-bypass` only in tests or with `LOCAL_DEV_PROFILE=true` plus `LOCAL_AUTH_BYPASS=true`; projects still use the server HTTP repository.
- Supabase Auth requires the backend URL and service-role key plus the frontend URL and publishable/anon key. HS256 installations also set `SUPABASE_JWT_SECRET`; asymmetric JWT installations use Supabase JWKS discovery or `SUPABASE_JWKS_URL`.
- `SqliteProjectStore` exists only as a fast backend route-test fixture; it is not a runtime option.

The public production origin must be listed explicitly with `CORS_ALLOWED_ORIGINS`.

Supabase email templates live in `supabase/templates/` and are synced with:

```bash
bun run supabase:templates:diff
bun run supabase:templates:sync
```

With Supabase local running, the real auth/RLS integration check is:

```bash
bun run test:supabase-local
```

## Deploy

Copy `deploy/.env.production.example` to `.env.production`, choose `SUPABASE_DEPLOYMENT=managed|self-hosted`, fill the public URLs and external credentials, then run `deploy/nous.sh setup` or `deploy/nous.ps1 setup`. See the [deployment guide](docs/DEPLOYMENT.md) for preflight, the pinned official self-hosted bundle, health/contract checks, reverse proxy, backup, restore proof, and rollback.

## What Lives Where

- Frontend app: `apps/web/`
- Backend API server: `apps/backend/src/`
- Tooling scripts: `scripts/`
- Documentation: `docs/`

Authenticated sessions use server storage. Import/export remains available for manual migration and backups.

## Useful Commands

```bash
bun run quality       # Type checks + Biome + dependency boundaries + React Hooks lint
bun run check:fallow  # Static dead-code & duplication analysis
bun run gate          # Full gate: quality + fallow + tests
bun run fix           # Auto-fix Biome lint, format, and import ordering
bun run format        # Format all files (Biome)
bun run test          # Vitest test suite (runs under Bun runtime)
bun run test:supabase-contract # Canonical Auth/RLS isolation contract
bun run test:supabase-local # Supabase local Auth/RLS integration test
```
