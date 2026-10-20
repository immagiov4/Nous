---
title: "Local Setup"
wiki_page_id: "p-local-setup"
---

# Local Setup

Follow the repository’s [local startup guide](../../../README.md#run-locally). Copy the [local environment example](../../../.env.example) to `.env.local`, then set the local Supabase credentials and the selected AI provider.

## Install and start

Use the Bun version declared by the project, install dependencies, then start the app:

| Command | Purpose |
| --- | --- |
| `bun run deps:install` | Install workspace dependencies. |
| `bun run dev` | Start the web app and backend. |
| `bun run doctor` | Check the local environment; see [Command-line tools](03-p-cli-tools.md). |

When the app is configured to use local Supabase, startup checks the local services and applies pending migrations. If the app uses a hosted Supabase instance, it does not need to start the local database stack.

## AI provider settings

Set credentials only for the provider you selected. For example, `OPENROUTER_API_KEY` is required when OpenRouter is selected; a Codex setup needs an authenticated account on the host instead.

## Runtime versions

Use the Bun version recorded in the project’s package metadata. Node 26 is used for the coverage command; the project pins the supported major version.
