# Nous Reader

Nous Reader turns uploaded documents into personalized study plans with lessons, quizzes, and laboratory exercises backed by AI feedback.

## Start Here

- [AI instructions](AGENTS.md)
- [Architecture guide](docs/ARCHITECTURE.md)
- [UI style guide](docs/UI_STYLE_GUIDE.md)

## Run Locally

1. Install the frontend dependencies:
   ```bash
   bun install
   ```
2. Install the backend dependencies:
   ```bash
   cd apps/backend && bun install && cd ../..
   ```
3. Set `OPENROUTER_API_KEY` in [.env.local](.env.local)
4. Start the app:
   ```bash
   bun run dev
   ```

This starts the Vite frontend on `http://localhost:5173` and the Express backend on `http://localhost:3301`.

## Server-Only Storage

Nous now uses authenticated server storage as the product path.

- Default backend storage is Postgres. Use `PROJECT_STORAGE_DRIVER=postgres` with `DATABASE_URL`.
- Frontend auth should use `VITE_AUTH_MODE=supabase`.
- Development can use `AUTH_MODE=local-bypass` only in tests or with `LOCAL_DEV_PROFILE=true` plus `LOCAL_AUTH_BYPASS=true`; projects still use the server HTTP repository.
- Supabase Auth requires `SUPABASE_URL`, `SUPABASE_JWT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `VITE_SUPABASE_URL`, and `VITE_SUPABASE_ANON_KEY`.
- SQLite is a legacy test/dev driver and is blocked outside `NODE_ENV=test` or `LOCAL_DEV_PROFILE=true`.

Production origins should be listed explicitly with `CORS_ALLOWED_ORIGINS`.

Supabase email templates live in `supabase/templates/` and are synced with:

```bash
bun run supabase:templates:diff
bun run supabase:templates:sync
```

With Supabase local running, the real auth/RLS integration check is:

```bash
bun run test:supabase-local
```

## What Lives Where

- Frontend app: `apps/web/`
- Backend API server: `apps/backend/src/`
- Tooling scripts: `tooling/scripts/`
- Documentation: `docs/`

Authenticated sessions use server storage. Import/export remains available for manual migration and backups.

## Useful Commands

```bash
bun run quality       # TypeScript type checks + Biome lint
bun run check:fallow  # Static dead-code & duplication analysis
bun run gate          # Full gate: quality + fallow + tests
bun run fix           # Auto-fix Biome lint, format, and import ordering
bun run format        # Format all files (Biome)
bun run test          # Vitest test suite (runs under Bun runtime)
bun run test:supabase-local # Supabase local Auth/RLS integration test
```
