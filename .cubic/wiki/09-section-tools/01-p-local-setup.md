---
title: "Local development setup"
wiki_page_id: "p-local-setup"
---

[Up one level](../index.md)

# Local development setup

Local development runs the React frontend and backend against PostgreSQL, Supabase Auth and Storage. The startup command coordinates local infrastructure when the configured URLs identify local services; a remote-only configuration connects to its existing services. Project persistence remains on the backend in both cases.

## Start the development processes

1. Use the Bun version declared in [package metadata](../../../package.json), then run `bun run deps:install` from the repository root.
2. Copy [`.env.example`](../../../.env.example) to `.env.local`. Set the database connection, backend Supabase URL and service-role key, frontend public URL and publishable/anonymous key, and server-side `OPENROUTER_API_KEY` for provider work.
3. Run `bun run dev`. The frontend serves at `http://localhost:5173` and the backend at `http://localhost:3301`.

For local service URLs, startup verifies Docker, starts Docker Desktop where supported, starts Supabase, checks Auth readiness and applies pending migrations before launching the app. A failed prerequisite exits startup instead of leaving a frontend disconnected from its backend. Use [environment diagnostics](03-p-cli-tools.md) to identify missing prerequisites. Node 26, pinned in `.node-version`, is required for the coverage path.

## Local authentication

The normal frontend mode is `VITE_AUTH_MODE=supabase`. HS256 installations set `SUPABASE_JWT_SECRET`; asymmetric installations use key discovery or `SUPABASE_JWKS_URL`. Set `SUPABASE_JWT_ISSUER` when the token issuer differs from the backend's internal service URL. [Authentication](../06-section-backend/02-p-auth.md) explains claim verification.

Tests can use controlled identity. An interactive local bypass requires `AUTH_MODE=local-bypass`, `LOCAL_DEV_PROFILE=true` and `LOCAL_AUTH_BYPASS=true`; it still persists projects through the server. Keep that backend within a trusted development environment. The backend accepts HTTP private-network origins on Vite port 5173 in every environment; an explicit `CORS_ALLOWED_ORIGINS` list does not disable that convenience. List public and other trusted origins explicitly when exposing the backend beyond loopback, and retain authentication for untrusted networks.

## Optional Codex text provider

Install and authenticate Codex CLI on the host and set `CODEX_APP_SERVER_ENABLED=true`. Nous uses one internal app-server account through its authenticated API for administrators and assigned users. Keep that process private to the backend. [The Codex adapter](../06-section-backend/03-p-codex-server.md) describes its execution restrictions; speech still needs OpenRouter.

Supabase email templates live under [supabase/templates](../../../supabase/templates/). `bun run supabase:templates:diff` inspects differences and `bun run supabase:templates:sync` applies them. With the stack ready, follow [verification](02-p-testing-quality.md) for fast checks on changed files, targeted tests and the CI integration contracts. [Deployment](../08-section-deployment/01-p-self-hosted.md) owns production service setup.
