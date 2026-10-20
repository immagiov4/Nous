---
title: "Environment diagnostic reference"
wiki_page_id: "p-cli-tools"
---

[Up one level](01-p-local-setup.md)

# Environment diagnostic reference

Run `bun run doctor` to inspect the environment. It reports findings without starting services, changing configuration or running tests.

| Command | Checks |
| --- | --- |
| `bun run doctor` | Runtime, installed tools and the Fallow baseline. |
| `bun run doctor -- --profile gate` | Local SonarQube readiness. |
| `bun run doctor -- --profile local` | Local Supabase services and migration parity. |
| `bun run doctor -- --profile all` | Default checks and both service profiles. |

Use the findings to identify the missing prerequisite, then return to [local setup](01-p-local-setup.md) or the [verification path](02-p-testing-quality.md). The diagnostic implementation is [scripts/doctor.ts](../../../scripts/doctor.ts); the full command list lives in [the testing guide](../../../docs/TESTING.md).
