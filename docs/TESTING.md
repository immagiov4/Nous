# Testing and quality gates

The root scripts in `package.json` are the canonical development and CI entrypoints.

## Routine checks

```bash
bun run doctor
bun run doctor -- --profile gate
bun run doctor -- --profile local
bun run doctor -- --profile all
bun run quality
bun run check:fallow
bun run test
bun run gate
bun run gate:full
```

- `doctor` verifies the Bun/CI runtime contract, installed project executables, and versioned
  Fallow baseline, then runs the core service-free quality and test checks independently so one
  failure does not hide later failures. The `gate` profile checks the existing local Sonar service
  and confirms that anonymous-analysis permissions were provisioned, while analysis remains
  restricted to its loopback-only Docker binding. The `local`
  profile checks the existing local Supabase services and migration parity,
  and `all` combines every profile. Every profile is read-only: it never starts, restarts,
  configures, or migrates a service.
- `quality` runs the TypeScript checks, Biome, dependency boundaries, and React Hooks lint.
- `test` runs the Vitest suite under Bun.
- `gate:checks` runs `quality` and Fallow.
- `gate` adds the Vitest suite to `gate:checks`.
- `gate:ci` uses the same blocking checks and fails when Fallow reports a finding identity that is
  absent from its versioned regression baseline. The output classifies findings as new, removed,
  or unchanged, so replacing one accepted finding with one new finding still fails even when the
  total is unchanged. The local `check:fallow` command remains informational. Refreshing the
  baseline first verifies that the current result introduces no new recorded debt.
- `gate:full` runs quality, the blocking Fallow regression check, the complete Bun suite, and Node
  coverage one at a time. It then starts the local Sonar service, runs the analysis, and stops the
  service. The stop command also runs when Sonar startup or analysis throws. The React Hooks ESLint
  check creates the external-issues report consumed by Sonar, so the scan does not repeat that lint
  pass. The scanner waits for the Sonar quality-gate result and propagates a failing gate.

## Pull request Sonar merge policy

SonarQube remains a local merge gate and is intentionally excluded from GitHub Actions. CI results
for TypeScript, tests, coverage, Fallow, and relevant contracts remain independent
authoritative checks. Classify the pull request before merging.

Sonar is required when the diff includes any of the following:

- analyzable application source in `apps/`, `packages/`, or analyzed tooling under `scripts/`;
- tests that change or establish behavioral contracts;
- source, build, dependency, or security configuration that changes analyzed runtime behavior; or
- an explicit review or CI request for Sonar.

For those pull requests, run the full gate on the exact commit proposed for merge:

```bash
bun run gate:full
```

The command must exit successfully, including the Sonar quality gate after coverage. A green CI
run does not substitute for this local result. Every new Sonar bug, vulnerability, security
hotspot, or code smell must be fixed or explicitly resolved with an owner-visible disposition
before merging.

Sonar may be skipped only when all of these conditions hold:

- the diff is trivially scoped and limited to documentation, metadata, or workflow files;
- it contains no analyzable application-code change and no source/build/dependency/security
  configuration change that affects analyzed runtime behavior;
- all required CI checks and review are clean; and
- no reviewer or CI signal requests Sonar.

The merge owner must record the skip rationale in the pull request. A small diff, a one-line
change, or the cost of running Sonar is not sufficient by itself; when scope is uncertain, run the
full gate. Do not treat a failed or unreachable required Sonar scan as a skip.

### When required Sonar is unavailable

`gate:full` starts Sonar immediately before analysis and stops it afterward. If startup fails, use
the standalone lifecycle command to diagnose the service before rerunning the full gate:

```bash
bun run sonar:up
bun run gate:full
```

`sonar:up` creates or reconciles the local service with its loopback-only binding and returns only
after the Docker-internal permission provisioner succeeds. On a fresh volume, that one-shot
provisioner grants the `Anyone` pseudo-group `Create Projects` and `Execute Analysis`, so no scanner
token or developer credential bootstrap is required. It polls readiness every second, fails immediately
when SonarQube reports `DB_MIGRATION_NEEDED`, and times out after 133 seconds. That bound is twice the
slowest observed local successful startup (66.4 seconds), preserving one additional full startup window
before classifying the service as unavailable. Do not
replace a required full gate with an isolated or skipped Sonar scan, and do not merge while a
required Sonar result is failed, unreachable, or unverified. Record the successful full-gate command
and Sonar result in the pull request before merging.

For an existing local volume whose administrator password was changed under the retired workflow,
`sonar:up` reuses the ignored legacy `sonar.local.properties` administrator settings only for the
Docker-internal provisioner. The scanner never reads those credentials or the retired token.
If that legacy pair is stale, the provisioner retries the fresh-volume default automatically. The
scanner also removes any inherited `SONAR_TOKEN` so the loopback scan remains anonymous.

Fallow fingerprints are SHA-256 hashes of the finding category and canonical JSON identity.
Source coordinates and suggested remediation actions are excluded, so moving a finding within the
same file does not change its identity. File moves and file or symbol renames appear as one removed
finding plus one new finding; the new identity remains blocking until the refactor is reviewed and
the baseline is refreshed explicitly.

The service is local-only. Docker publishes it exclusively on `127.0.0.1:9000`; its internal
provisioner has no published port and permits anonymous analysis only through that loopback-bound
service.

## Sonar quality ratchet

Run `bun run gate:full` once on the exact final merge candidate. Triage every new bug,
vulnerability, and security hotspot before considering the batch complete. Existing code-smell debt
may be addressed in an explicitly scoped cleanup batch; there is no fixed per-batch quota.

Biome fixes and formatting remain separate, explicit commands:

```bash
bun run fix
bun run format
```

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

CI runs `test:workflow-postgres:critical` on pull requests that change backend runtime code,
workflow integration tests, shared persistence contracts, migrations, dependency resolution, or the
CI/test configuration and shared Vitest setup. The backend boundary intentionally includes
transitive workflow dependencies in configuration, services, and utilities. The selector reads the
complete base-to-head Git diff, with rename detection disabled so moving a load-bearing file out of
an owned directory still selects the contract. The subset covers run persistence, fencing, signal
replay, and abrupt-process recovery. The complete `test:workflow-postgres` matrix, including undo
and project transactions, runs on every push to `main`. Real provider tests remain manual and paid.

Evidence from three successful `main` runs on 2026-08-15 (Actions runs 31906123273, 31908105475,
and 31908540049) measured the complete PostgreSQL test step at 13–15 seconds. The surrounding
Supabase contract job took 4 minutes 12 seconds to 4 minutes 28 seconds, of which local Supabase
startup took 3 minutes 8 seconds to 3 minutes 17 seconds. The pull-request subset therefore reuses
the already-running Supabase job instead of provisioning a second database stack.

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
