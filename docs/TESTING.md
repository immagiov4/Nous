# Testing and quality gates

The root scripts in `package.json` are the canonical development and CI entrypoints.
Install [uv](https://docs.astral.sh/uv/getting-started/installation/) so the gate can run its pinned
Semgrep CLI through `uvx`. There is no alternate Semgrep runner.

## Routine checks

```bash
bun run quality
bun run check:fallow
bun run test
bun run gate
bun run gate:full
```

- `quality` runs the TypeScript checks, Biome, dependency boundaries, and React Hooks lint.
- `test` runs the Vitest suite under Bun.
- `gate:checks` runs `quality`, the Semgrep rule tests and repository scan, and Fallow.
- `gate` adds the Vitest suite to `gate:checks`.
- `gate:ci` uses the same blocking checks and fails when Fallow exceeds its versioned regression
  baseline. The local `check:fallow` command remains informational. Refreshing the baseline first
  verifies that the current result does not increase the recorded debt.
- `gate:full` runs `gate`, generates frontend LCOV coverage on Node, and launches the local Sonar
  scan. The complete suite still runs on Bun; the Node pass is limited to frontend tests because
  backend deployment tests exercise Bun-specific APIs. The full gate completes every stage so a
  local lint or test failure cannot silently skip Sonar, then exits with a failure if any stage
  failed. The scanner waits for the Sonar quality-gate result and propagates a failing gate.

Before the first local full gate, start and initialize Sonar with `bun run sonar:up` and
`bun run sonar:bootstrap`. The generated credentials stay in the ignored
`sonar.local.properties` file.

## Sonar quality ratchet

Run `bun run gate:full` after each non-trivial completed batch. Triage every new bug,
vulnerability, and security hotspot before considering the batch complete. When safe unresolved
code-smell debt remains, each batch should also remove at least 10 findings. Record the reason when
there are not 10 safe findings in scope; do not force speculative refactors merely to reach the
number.

Biome fixes and formatting remain separate, explicit commands:

```bash
bun run fix
bun run format
```

## Semgrep maintainability checks

Semgrep is executed through the pinned version in the root scripts:

```bash
bun run check:semgrep:rules
bun run check:semgrep
```

`check:semgrep:rules` validates the annotated positive and negative fixtures beside the rules.
`check:semgrep` scans the repository and fails on any finding.

Only deterministic, high-confidence syntax rules belong in this gate. A new rule must:

1. start with meaningful `ruleid` and `ok` fixtures;
2. avoid duplicating Biome, TypeScript, dependency-cruiser, Fallow, or Sonar;
3. pass its fixtures and a full-repository scan without accepted false positives.

Rules based on semantic guesses, model output, arbitrary size or usage thresholds, or source-text
keyword lists do not belong in Semgrep.

## Supabase contract

```bash
bun run test:supabase-contract
bun run test:supabase-local
```

Both names run the canonical local Auth/RLS contract. See [Deployment](DEPLOYMENT.md) for local and
managed staging prerequisites.

## Durable workflow PostgreSQL contract

Run the real persistence, claim, fencing, recovery, signal, fan-out, outbox, undo, and abrupt
worker-process recovery contract against an isolated migrated PostgreSQL database:

```bash
WORKFLOW_INTEGRATION_DATABASE_URL=postgresql://... bun run test:workflow-postgres
```

The command is intentionally opt-in because it writes temporary users, projects, workflow runs,
and attempts. Never point it at production. Every fixture uses unique identifiers and removes its
own data; `WORKFLOW_INTEGRATION_DATABASE_URL` is mandatory so the suite cannot silently reuse the
application database. The main persistence batch runs without file parallelism; abrupt-process
recovery runs separately. The suite also covers rolling-definition authority, stale replicas,
workflow-set version ordering, late checkpoint/undo fencing, worker crashes, and cross-replica
project-revision inbox delivery.

CI runs the critical run/execution/signal/crash subset on pull requests and the complete
`test:workflow-postgres` contract on pushes to `main`. Real provider tests remain manual and paid.

## Real Codex workflow smoke test (manual and paid)

The course, lesson, and visual-artifact smoke flow is deliberately outside `test`, `gate`, and CI.
It exercises the real HTTP routes on an ephemeral loopback server, the durable worker, and
PostgreSQL checkpoints with a temporary learn-mode project. Generated assets use process-local
memory storage and the temporary project is removed at the end. The database must be a migrated,
workflow-runtime-empty loopback instance; remote databases are rejected.

Validate the harness and resolved models without a database or provider request:

```bash
bun run test:workflow-codex -- --dry-run
```

To make the paid Codex run explicit in PowerShell:

```powershell
$env:REAL_WORKFLOW_PROVIDER_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
$env:RUN_REAL_WORKFLOW_PROVIDER_TESTS = 'I_ACCEPT_REAL_PROVIDER_COSTS'
bun run test:workflow-codex -- --run
```

This is intentionally a Codex-only smoke test; it does not claim live coverage of OpenRouter or
OpenAI billing. It freezes course and lesson on `gpt-5.6-luna` with low reasoning and normal
service tier, and visual work on `gpt-5.6-sol` with low reasoning. Auxiliary research uses Luna.
These overrides exist only in the test process and are not persisted. The harness runs at most two
workflow steps concurrently (hard cap: four) and gives each of the three workflow runs 15 minutes
by default. Override those test-only limits with `REAL_WORKFLOW_PROVIDER_CONCURRENCY` and
`REAL_WORKFLOW_PROVIDER_TIMEOUT_MS`. It also verifies the persisted model snapshot and positive
input/output usage for every run. The Codex app server must already be authenticated.
