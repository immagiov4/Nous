---
title: "Run Nous locally"
wiki_page_id: "p-local-setup"
---

[Up one level](../index.md)

# Run Nous locally

A local instance lets you open the library and study a lesson while changing the app. Follow [the startup guide](../../../README.md#run-locally) for environment requirements and service setup.

1. Use the Bun version declared in [package metadata](../../../package.json) and run `bun run deps:install`.
2. Copy [`.env.example`](../../../.env.example) to `.env.local`. Set Supabase credentials and the chosen AI provider; keep secrets in that local file.
3. Run `bun run dev`. Open the frontend at `http://localhost:5173`; the backend listens at `http://localhost:3301`.
4. Sign in and follow [Create your first course](../01-section-overview/01-p-overview.md) to exercise a learning path.

## If startup stops

Local Supabase configurations check Docker, start local services and apply pending migrations before launching the app. A remote-only configuration skips local infrastructure startup. Use [environment diagnostics](03-p-cli-tools.md) to inspect a failure.

OpenRouter needs its server API key. A Codex setup needs the [host account connection](../06-section-backend/03-p-codex-server.md). The startup guide owns restricted local authentication options.

Once running, use the [code map](../02-section-architecture/01-p-architecture.md) to find a change's owner and [testing](02-p-testing-quality.md) to verify it. Node 26, pinned in `.node-version`, is required for coverage.
