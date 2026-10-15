# Testing and quality gates

The root scripts in `package.json` are the canonical development and CI entrypoints.

## Routine checks

After installing project dependencies, run `bunx playwright install chromium` to provide Chromium for browser tests, including `bun run test` and the coverage stage of `bun run gate:full`.

```bash
bun run doctor
bun run doctor -- --profile gate
bun run doctor -- --profile local
bun run doctor -- --profile all
bun run quality
bun run check:fallow
bun run test
```

- `doctor` verifies the Bun/CI runtime contract, installed project executables, and versioned
  Fallow baseline. It does not run quality or tests. The `gate` profile checks the existing local Sonar service
  and confirms that anonymous-analysis permissions were provisioned, while analysis remains
  restricted to its loopback-only Docker binding. The `local`
  profile checks the existing local Supabase services and migration parity,
  and `all` combines every profile. Every profile is read-only: it never starts, restarts,
  configures, or migrates a service.
- `quality` runs the TypeScript checks, Biome, and React Hooks lint. CI extends it with the
  dependency boundary check through `quality:ci`.
- `test` runs the Vitest suite under Bun.
- `gate:ci` uses the same blocking checks and fails when Fallow reports a finding identity that is
  absent from its versioned regression baseline. The output classifies findings as new, removed,
  or unchanged, so replacing one accepted finding with one new finding still fails even when the
  total is unchanged. The local `check:fallow` command remains informational. Refreshing the
  baseline first verifies that the current result introduces no new recorded debt.

## Final local validation

After GitHub CI passes on the final commit, run:

```bash
bun run gate:full
```

- `gate:full` runs the shared `gate:ci` command (CI quality including dependency validation, Fallow, and the complete Bun suite), then Node coverage, one stage at a time after GitHub CI passes on the same commit. The CI test job uses the same command, and a behavior test compares the workflow checks with the scripts actually invoked by the local gate. It then starts or reuses the local Sonar service, verifies the pinned Bun runtime and Sonar readiness with `doctor:gate`, and runs the analysis. The service stays running after success or failure; each invocation repeats readiness and doctor checks before the same quality gate. Run `bun run sonar:stop` when finished to release the server resources. The React Hooks ESLint check creates the external-issues report consumed by Sonar, so the scan does not repeat that lint pass. The scanner waits for the Sonar quality-gate result and propagates a failing gate.
- `test:coverage` requires Node 26 (any 26.x), the major pinned in `.node-version`. It stops before Vitest if PATH resolves to another Node major. Its preflight deletes the previous `coverage/lcov.info` before that check, so a later Sonar stage cannot consume stale coverage. It shares the Vitest worker limit defined in `apps/web/vitest.config.ts` with the Bun suite and writes only the report Sonar consumes. CI does not generate and discard a second coverage report.

`bun run prepare:coverage` removes stale coverage, verifies the Node major, and then runs the idempotent `bunx playwright install chromium` command before coverage tests start.

The CI test job and local full gate share `gate:ci`, defined in `package.json`. Its checks stop at the first failure; the full gate still records that failed stage and continues through Node coverage and Sonar. Separate CI jobs retain the Supabase Auth/RLS contract, the change-selected critical PostgreSQL contract, the full PostgreSQL contract on main, and the credential-dependent staging contract. Remote pull-request-body verification also remains a separate workflow. The pull-request contracts and remote body verification remain CI merge prerequisites with their own service and event requirements. The full PostgreSQL and credential-dependent managed-staging checks run on pushes to main after merge.

## Pull request Sonar merge policy

SonarQube remains a local merge gate and is intentionally excluded from GitHub Actions. CI checks
TypeScript, dependency boundaries, the complete Bun suite, Fallow, and relevant contracts. The
local gate adds Node coverage and Sonar on the same commit. Classify the pull request before merging.

Sonar is required when the diff includes any of the following:

- analyzable application source in `apps/`, `packages/`, or analyzed tooling under `scripts/`;
- tests that change or establish behavioral contracts;
- source, build, dependency, or security configuration that changes analyzed runtime behavior; or
- an explicit review or CI request for Sonar.

For those pull requests, wait for CI to pass, then run the full gate on the same commit:

```bash
bun run gate:full
```

Both CI and the command must exit successfully. The local result includes Node coverage followed by
the Sonar quality gate. Every new Sonar bug, vulnerability, security hotspot, or code smell must be
fixed or explicitly resolved with an owner-visible disposition before merging.

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

`gate:full` starts or reuses Sonar immediately before analysis and keeps it running afterward, including after a failed scan. Stop it explicitly with `bun run sonar:stop` when finished. If startup fails, use the standalone lifecycle command to diagnose the service before rerunning the full gate:

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

After GitHub CI passes, run `bun run gate:full` once on the exact final merge candidate. Triage every new bug,
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

Pull requests run this contract against the disposable local Supabase stack. CI exposes managed
staging credentials only to the trusted `main` revision after merge.

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

## Real-provider workflow matrix (manual)

The [workflow matrix](../.cubic/wiki/09-section-tools/02-p-testing-quality.md#real-provider-workflow-matrix) exercises course, lesson and visual-artifact generation through real HTTP routes, durable workers and PostgreSQL checkpoints. Select `--provider codex|openrouter`, `--case simple|realistic`, and exactly one of `--dry-run` or `--run`. Run the simple learn-mode case first, then the realistic two-lesson PDF case. The retained SVG request resolves to a native lesson scene under the current application contract; the harness checks its scene schema. OpenRouter cells additionally exercise the TTS route and retain its audio response.

```bash
bun run test:workflow-providers -- --provider codex --case simple --dry-run
bun run test:workflow-providers -- --provider openrouter --case simple --dry-run
bun run test:workflow-providers -- --provider openrouter --case realistic --dry-run
```

OpenRouter dry runs read the free model catalogue and validate every selected text-model ID before paid calls. The harness loads the resolved global configuration and preserves application reasoning efforts and Codex service tiers. Codex cells use the application's resolved default models for every slot, including artifacts; only OpenRouter cells substitute small text models (`openai/gpt-5.6-luna`, or `openai/gpt-6-luna` for scenes, scene icons and playback preparation). Real runs require an external evidence directory and a fresh, migrated loopback database with empty project, workflow-run and asset-deletion tables. Create one disposable database per cell and drop it after evidence collection. Generated assets and source objects use process-local memory storage. The manifest records the provider, case, effective slots, workflow durations, token usage and outcomes alongside final traces and model exchanges.

```powershell
$env:NOUS_E2E_DATA = 'C:/temp/nous-workflow-evidence'
$env:REAL_WORKFLOW_PROVIDER_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:55322/nous_workflow_disposable'
$env:RUN_REAL_WORKFLOW_PROVIDER_TESTS = 'I_ACCEPT_REAL_PROVIDER_COSTS'
bun run test:workflow-providers -- --provider codex --case simple --run
# Use another fresh disposable database for the next cell.
bun run test:workflow-providers -- --provider codex --case realistic --run
```

Codex uses the local ChatGPT login; the harness enables `CODEX_APP_SERVER_ENABLED=true` before runtime startup. The `test:lesson-quality` and `test:lesson-evidence-quality` scripts also enable this flag after their cost acknowledgement and require the authenticated local ChatGPT account and external evidence directory. OpenRouter real runs require `OPENROUTER_API_KEY` and maintainer approval for paid calls. These manual real-provider runs remain outside the deterministic test suite, gates and CI. See the testing wiki for model selection, retained evidence and speech-usage limits.

Set `CODEX_APP_SERVER_ENABLED=true` and review each retained run with `bun run xray -- <run-directory>`. X-ray sends complete exchanges grouped by recorded workflow run, node and attempt, with manifest context in every turn. Unassigned exchanges share a chronological group. It merges supported findings into `xray.json` and `xray.md`, preserving original exchange references. If a complete node exceeds the provider limit, the report retains the measured bytes and characters as an evidence limit, continues reviewing other nodes and returns `needs-maintainer`. Preserve existing review files before requesting a new review; exclusive creation prevents overwriting evidence.
