---
title: "Command-line Tools"
wiki_page_id: "p-cli-tools"
---

# Command-line Tools

The command-line tools help developers check the local setup, run quality checks and inspect services. The diagnostic command is observational: it reports what it finds and does not start services, change configuration or run tests.

## Environment diagnostics

Run `bun run doctor` to check the service-free development environment. Select a profile when you need a specific service probe:

| Command | What it checks |
| --- | --- |
| `bun run doctor` | Default checks for the runtime, dependencies and Fallow baseline. |
| `bun run doctor -- --profile gate` | Local SonarQube readiness. |
| `bun run doctor -- --profile local` | Local Supabase services and migration parity. |
| `bun run doctor -- --profile all` | The default checks and both service probes. |

## Quality checks

| Command | Purpose |
| --- | --- |
| `bun run quality` | TypeScript, Biome and React Hooks checks. |
| `bun run quality:ci` | CI quality checks, including dependency boundaries. |
| `bun run check:fallow` | Report dead-code and duplication findings. |
| `bun run test` | Run the Vitest suite under Bun. |
| `bun run gate:ci` | Run the CI gate locally, including the baseline comparison and test suite. |
| `bun run gate:full` | After CI passes, run `gate:ci`, Node coverage and SonarQube analysis. |

Run `bun run gate:full` once on the final merge candidate after implementation and review are complete. It requires Node 26 for coverage and starts or reuses local SonarQube before analysis. SonarQube remains running when the command finishes; use `bun run sonar:stop` when finished.

For local setup, see [Local setup](01-p-local-setup.md). For the testing workflow and provider-backed evaluations, see [Testing and quality checks](02-p-testing-quality.md).
