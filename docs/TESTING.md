# Testing and quality gates

Run fast checks on changed files and targeted tests while editing, then push for full CI verification. Merge only when CI is green on the exact pull-request head, including `test`, `SonarCloud Code Analysis`, and the applicable contract and pull-request-body checks. Each new commit needs its own passing checks. Record CI and SonarCloud status together on one line in the PR body's `## Testing` section; `scripts/github-body.mjs` owns the body contract.

Browser tests are always muted; audio is verified inside the page or from files.

## Cloud Codex environment

After dependencies are installed, run `bun run setup:codex` in the cloud setup command. It installs Geppetto at the commit already pinned by the PR gate, and My Codex Skills and Ponytail at reviewed commits, through Codex's native plugin manager. Pin changes replace only clean native marketplaces from those repositories; custom sources, sparse configurations and local edits stop setup for preservation. It reuses the machine's memory choice, otherwise links the existing Nous memory repository, adopts the project, approves only the two installed hook packs, and checks their skills through the native discovery API. Geppetto reuses the maintenance jobs already registered on another machine.

Start a fresh Codex session after setup. Use `$my-codex-skills:engineering-workflow` and `$ponytail:ponytail`; apply relevant `$my-codex-skills:principle-<name>` skills automatically when their task conditions apply. These installed skills own automatic selection; vendored copies remain explicit. See `.agents/skills/THIRD_PARTY_SKILLS.md#automatic-principle-selection` for selection and context-cost metrics. Plugin installation and trusted hashes establish configuration; actual session IDs in `.geppetto/hook-events.jsonl` establish execution. Verify startup, a tool call and completion in that fresh session. The active chat may have started before setup and does not gain hook evidence retroactively.

Codex CLI authentication belongs to the cloud environment. If a real turn reports an expired login, run `codex login --device-auth` and complete the device flow; never commit authentication files. The setup command does not change credentials or run a model. Learning uses the configured model and the existing Geppetto lifecycle. Keep runtime evidence outside Git.

Run `bun run gate:cloud` for the complete gate in this Linux cloud image. It uses a sibling directory for disk-backed temporary staging, a Git discovery ceiling to isolate temporary repositories from enclosing checkouts, and the image's existing `docker-init` as a subreaper. This covers the image's tmpfs `/tmp` and non-reaping PID 1 without changing application checks or timeouts. The four signal-cleanup cases that timed out on the unchanged base pass under this command's process supervisor.

## Local checks

After installing dependencies with `bun run deps:install`, install Chromium for browser tests:

```bash
bunx playwright install chromium
```

Use the narrowest check that covers your change:

```bash
bun run check:changed
bun run test -- path/to/affected.test.ts
bun run lint:types  # When types or interfaces changed
```

`bun run doctor` checks the local environment. Add `-- --profile local` for Supabase and migration parity, `-- --profile gate` for the existing local Sonar service, or `-- --profile all` for both. All profiles are read-only.

Changed-file checks run without the shared heavy-run lock. CI owns full quality, tests, coverage and SonarCloud. Browser suites and other heavy package scripts queue automatically across worktrees. Use `bun scripts/heavy-run.mjs status` to inspect the queue and wrap additional browser or Docker proofs with `bun scripts/heavy-run.mjs --label "who/what" -- <command...>`.

### Heavy command leases

`heavy-run` admits commands in FIFO order, with four slots by default and optional `--weight` and `HEAVY_RUN_SLOTS`. Every entry records its label, PID, command, queue time, command start and last activity. `bun scripts/heavy-run.mjs status` lists held and waiting entries; `bun scripts/heavy-run.mjs release <id>` cancels a waiting entry or stops a running command tree before freeing its slots. Pass credentials through the environment rather than command arguments.

Windows commands use a named native Job Object through a Bun FFI helper, including Node callers. The root is created suspended and assigned before admission resumes it. The lease stays held while the Job reports active processes, including descendants whose root has exited. Killing its helper closes the Job and terminates its members; supervisor disconnect also terminates it. Release terminates the named Job and waits for zero active members. CI bypasses local admission.

POSIX completion retains the lease until its process group is empty, including after root exit. Release verifies a living worker's OS creation identity; a retained group whose leader has exited is stopped by its recorded group ID. Both paths wait for every member to cease work. Terminated processes awaiting OS reaping do not hold capacity. Older running records without a verifiable creation identity retain capacity until their command exits. Identity capture follows IPC admission.

Only command execution acquires a lease; manual reservations are unsupported. Prepare files and wait for external signals before invoking the wrapper. Nested wrappers reuse the inherited lease instead of waiting for another slot. An inherited holder that clears `HEAVY_RUN_HELD` receives an error while its lease is active.

A holder without a living command expires after two seconds without activity; admission checks run every second. A registered worker awaiting its supervisor's admission also expires after two seconds. A dead holder or recorded command is reclaimed on the next check, after its native group ceases work. Surviving POSIX commands keep capacity after supervisor death. Running commands renew activity every 30 seconds and retain their lease throughout silent gates and browser work. Waiting tickets retain the existing ten-minute heartbeat expiry.

The idle window covers command startup, not output gaps or total execution time. On Windows with Bun 1.4.0, one real caption-row suite registered its child in 52.9 ms and passed 24 Chromium and 24 Firefox cases (115.6 s and 218.5 s); two real `gate:ci` runs registered in 55–66 ms. These uncontended queue-to-registration measurements include record creation and worker spawn. The two-second window rounds the observed maximum up to the one-second admission interval and adds one admission interval. The passing gate retained its lease for 548 seconds with 18 activity renewals, including silent stages.

With native Windows Job ownership, an uncontended real `gate:ci` registers in 175 ms, including FFI setup, Job creation and assignment of its suspended root. Rounding this observed startup to one admission interval still gives the same two-second idle window.

Four concurrent real layout-browser proofs at the default four-slot capacity also pass. With Node 26.4.0 on Windows, publication-to-worker registration takes 35–39 ms across those four runs; FIFO waiting time is measured separately. These measurements calibrate the supported workload rather than promise a worst-case bound under arbitrary OS starvation. A supervisor that neither registers a command nor renews activity within the idle window loses its lease.

## CI and merge readiness

The CI `test` job runs `bun run gate:ci`: full `quality:ci` checks, dependency boundaries, the Fallow regression check, and one complete Node test suite with coverage. It then runs SonarQube Cloud analysis and waits for its quality-gate result. CI checks out the pull-request head and reports Sonar analysis against that same commit.

Wait for all applicable CI checks and review before merging. Fix or explicitly resolve every new Sonar finding with an owner-visible disposition. A missing or failed SonarCloud result blocks merging; diagnose it in the CI logs and SonarCloud report.

Pull requests also run the Supabase contract and remote body verification. The critical PostgreSQL contract is selected by the changed paths; the complete PostgreSQL and managed-staging contracts run on pushes to `main`.

<details><summary>Details</summary>

Coverage uses the Node major pinned in `.node-version` and the ordered Vitest projects in `apps/web/vitest.config.ts`. Its preflight removes stale LCOV, checks Node, and installs Chromium. One coverage-producing suite supplies both the test result and the Sonar report.

Fallow compares finding identities with `config/fallow-baselines/regression.json`; every new identity blocks CI. Refresh the baseline explicitly after reviewing the change. The scripts own fingerprinting and report details.

SonarQube Cloud analysis runs for same-repository pull requests and pushes to `main`. Fork pull requests need a trusted analysis result on the exact proposed head before merging because CI withholds the scanner secret.

</details>

## Diagnose Windows-specific failures

Use the local full gate when diagnosing a Windows-specific failure:

```bash
bun run gate:full
bun run sonar:stop
```

Run one heavy analysis process at a time and stop the local Sonar service after success or failure. For unrelated test timeouts under load, run the affected files in isolation before changing timeout policy.

<details><summary>Details</summary>

`gate:full` runs `gate:checks`, Node coverage, local Sonar startup, `doctor:gate`, and analysis sequentially. It records failed stages and continues through the stages it can run. The service stays running until `sonar:stop`.

If local Sonar startup fails, diagnose it with `bun run sonar:up`. Docker binds the service to `127.0.0.1:9000`; its internal provisioner enables anonymous analysis on that local service. Lifecycle and scanner scripts own readiness checks and configuration.

</details>

## Supabase contract

```bash
bun run test:supabase-contract
bun run test:supabase-local
```

Both names run the canonical local Auth/RLS contract. See [Deployment](DEPLOYMENT.md) for local and managed staging prerequisites.

Pull requests run this contract against the disposable local Supabase stack. CI exposes managed staging credentials only to the trusted `main` revision after merge.

## Durable workflow PostgreSQL contract

Run the real persistence, claim, fencing, recovery, signal, fan-out, outbox, undo, and abrupt worker-process recovery contract against an isolated migrated PostgreSQL database:

```bash
WORKFLOW_INTEGRATION_DATABASE_URL=postgresql://... bun run test:workflow-postgres
```

The command is intentionally opt-in because it writes temporary users, projects, workflow runs, and attempts. Never point it at production. Every fixture uses unique identifiers and removes its own data; `WORKFLOW_INTEGRATION_DATABASE_URL` is mandatory so the suite cannot silently reuse the application database. The main persistence batch runs without file parallelism; abrupt-process recovery runs separately. The suite also covers rolling-definition authority, stale replicas, workflow-set version ordering, late checkpoint/undo fencing, worker crashes, and cross-replica project-revision inbox delivery.

CI runs `test:workflow-postgres:critical` on pull requests that change backend runtime code, workflow integration tests, shared persistence contracts, migrations, dependency resolution, or the CI/test configuration and shared Vitest setup. The backend boundary intentionally includes transitive workflow dependencies in configuration, services, and utilities. The selector reads the complete base-to-head Git diff, with rename detection disabled so moving a load-bearing file out of an owned directory still selects the contract. The subset covers run persistence, fencing, signal replay, and abrupt-process recovery. The complete `test:workflow-postgres` matrix, including undo and project transactions, runs on every push to `main`. Real provider tests remain manual and paid.

Evidence from three successful `main` runs on 2026-08-15 (Actions runs 31906123273, 31908105475, and 31908540049) measured the complete PostgreSQL test step at 13–15 seconds. The surrounding Supabase contract job took 4 minutes 12 seconds to 4 minutes 28 seconds, of which local Supabase startup took 3 minutes 8 seconds to 3 minutes 17 seconds. The pull-request subset therefore reuses the already-running Supabase job instead of provisioning a second database stack.

## Real-provider workflow matrix (manual)

The workflow matrix exercises course, lesson and visual-artifact generation through real HTTP routes, durable workers and PostgreSQL checkpoints. Select `--provider codex|openrouter`, `--case simple|realistic`, and exactly one of `--dry-run` or `--run`. Run the simple learn-mode case first, then the realistic two-lesson PDF case. The retained SVG request resolves to a native lesson scene under the current application contract; the harness checks its scene schema. OpenRouter cells additionally exercise the TTS route and retain its audio response.

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

Codex uses the local ChatGPT login; the harness enables `CODEX_APP_SERVER_ENABLED=true` before runtime startup. The `test:lesson-quality` and `test:lesson-evidence-quality` scripts also enable this flag after their cost acknowledgement and require the authenticated local ChatGPT account and external evidence directory. OpenRouter real runs require `OPENROUTER_API_KEY` and maintainer approval for paid calls. These manual real-provider runs remain outside the deterministic test suite, gates and CI. For provider prerequisites and evidence privacy, see [the evaluation guide](../.cubic/wiki/09-section-tools/02-p-testing-quality.md#evaluate-generated-content).

Set `CODEX_APP_SERVER_ENABLED=true` and review each retained run with `bun run xray -- <run-directory>`. X-ray sends complete exchanges grouped by recorded workflow run, node and attempt, with manifest context in every turn. Unassigned exchanges share a chronological group. It merges supported findings into `xray.json` and `xray.md`, preserving original exchange references. If a complete node exceeds the provider limit, the report retains the measured bytes and characters as an evidence limit, continues reviewing other nodes and returns `needs-maintainer`. Preserve existing review files before requesting a new review; exclusive creation prevents overwriting evidence.
