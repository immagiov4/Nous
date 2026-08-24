# Nous Reader

Nous Reader turns uploaded documents and researched topics into personalized courses with lessons, reflection prompts, and application exercises backed by AI feedback.

## Start Here

- [AI instructions](AGENTS.md)
- [Code structure, packages, workspaces, and ownership](.cubic/wiki/index.md)
- [Production deployment](docs/DEPLOYMENT.md)
- [Testing and quality gates](docs/TESTING.md)
- [Product and design manifesto](https://github.com/immagiov4/Lumina-Reader/discussions/33)

## Run Locally

1. Install the Bun workspace dependencies:
   ```bash
   bun run deps:install
   ```
2. Copy [.env.example](.env.example) to `.env.local` and set the local Supabase keys plus `OPENROUTER_API_KEY`. `OPENAI_API_KEY` is optional.
3. Start the app:
   ```bash
   bun run dev
   ```

This starts the Vite frontend on `http://localhost:5173` and the Express backend on `http://localhost:3301`.

When the configured Supabase or Postgres URL points to the local machine, `bun run dev` also verifies Docker, starts Docker Desktop on Windows or macOS when needed, starts the local Supabase stack, and checks Supabase Auth before launching the app. If those services cannot start, the command exits instead of leaving a frontend without its backend. Remote-only configurations skip this local infrastructure check.

To use a ChatGPT/Codex account on a self-hosted Nous instance without copying its credentials into Nous, install Codex CLI and set `CODEX_APP_SERVER_ENABLED=true`. One internal `codex app-server` process serves the instance's authenticated administrators and the Nous users explicitly assigned to Codex in the admin panel; they share that single Codex account. Remote users reach Nous through its authenticated HTTPS API—the app-server itself remains private to the backend. Hosted/shared deployments leave this mode disabled and use OpenAI API or OpenRouter instead.

## Server-Only Storage

Nous now uses authenticated server storage as the product path.

- Project storage is Postgres and requires `DATABASE_URL`.
- Frontend auth should use `VITE_AUTH_MODE=supabase`.
- Development can use `AUTH_MODE=local-bypass` only in tests or with `LOCAL_DEV_PROFILE=true` plus `LOCAL_AUTH_BYPASS=true`; projects still use the server HTTP repository.
- Supabase Auth requires the backend URL and service-role key plus the frontend URL and publishable/anon key. HS256 installations also set `SUPABASE_JWT_SECRET`; asymmetric JWT installations use Supabase JWKS discovery or `SUPABASE_JWKS_URL`.
- Set `SUPABASE_JWT_ISSUER` when the token issuer is different from the backend's internal `SUPABASE_URL`.
- Backend route tests use an in-memory `ProjectStore`; PostgreSQL is the only runtime project store.

Always list the public production origin explicitly with `CORS_ALLOWED_ORIGINS`, including when the
backend listens on loopback behind a reverse proxy. When `BACKEND_HOST` exposes the backend beyond
loopback, list every other trusted frontend origin explicitly too, especially when using
`local-bypass`. The backend still accepts every HTTP RFC1918 origin on Vite port 5173 in every
environment; `CORS_ALLOWED_ORIGINS` does not disable this convenience. CORS limits browser origins
but does not replace authentication; do not expose a `local-bypass` backend to an untrusted LAN.

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

Copy `deploy/.env.production.example` to `.env.production`, choose `SUPABASE_DEPLOYMENT=managed|self-hosted`, fill the public URLs and external credentials, then run `sh deploy/nous.sh setup` or `deploy/nous.ps1 setup`. See the [deployment guide](docs/DEPLOYMENT.md) for preflight, the pinned official self-hosted bundle, health/contract checks, reverse proxy, backup, restore proof, and rollback.

## What Lives Where

Code-level structure, package responsibilities, workspace boundaries, and dependency ownership are
maintained in the [Cubic wiki](.cubic/wiki/index.md). Product intent remains in the
[manifesto](https://github.com/immagiov4/Lumina-Reader/discussions/33); deployment and quality
procedures remain in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) and
[docs/TESTING.md](docs/TESTING.md).

Authenticated sessions use server storage. Import/export remains available for manual migration and backups.

## Useful Commands

Use `bun run doctor` for an actionable local health report. GitHub CI runs the complete Bun suite;
`bun run gate:full` adds coverage and Sonar on the final commit. See
[Testing and quality gates](docs/TESTING.md) for the canonical command list and CI contract.
