---
title: "Testing and merge evidence"
wiki_page_id: "p-testing-quality"
---

[Up one level](01-p-local-setup.md)

# Testing and merge evidence

Verification starts at the changed behavior and expands to the service boundaries it crosses. Focused deterministic tests establish repeatable contracts; database, provider and browser checks establish integrations their test doubles cannot cover. The required merge evidence is green CI on the exact PR head, including SonarCloud and applicable contract checks.

Browser tests are always muted; audio is verified inside the page or from files.

The playback layout and audio-signal suites share one fixture build and preview server, prepared once before their workers start, as the caption and focus contracts do. Compilation completes before browser navigation; individual hooks and tests retain their existing deadlines.

The production audio contract runs Chromium and Firefox against the built frontend. Linux CI supplies a PulseAudio null sink so Firefox can start its real audio clock without a physical output device. The test step owns that audio server and stops it on exit.

## During development

Local checks stay on changed files: run `bun run check:changed` and the targeted behavior tests for the code changed. The command applies Biome and both ESLint configurations to existing changed files against the merge base with `origin/main`, including staged, unstaged and untracked work. Run `bun run lint:types` when types or interfaces change. These fast checks run directly; CI owns full-repository quality, tests, coverage and SonarCloud. The [quality workflow](../../../.agents/skills/quality-workflow/SKILL.md) describes verification depth for integrations and visual changes, while this page defines the local/CI split and merge requirement.

Route tests can use controlled stores and identities. Real Supabase checks exercise authentication, row-level security and PostgreSQL persistence with the local stack; `bun run test:supabase-local` runs the corresponding integration set. Workflow PostgreSQL contracts exercise durable execution and recovery. The [testing guide](../../../docs/TESTING.md) owns detailed prerequisites and specialized commands.

## Shared local execution

Local real-app proofs reuse one Supabase stack across worktrees and evidence directories. `bun run playtest` checks the shared stack automatically; custom authenticated proofs use `bun run proof bun <proof-script>`. The shared manager selects the existing `nous-reader` database, or adopts `nous-playtest` when that is the existing stack. Auth, REST and Storage health checks precede admission. An absent stack starts as `nous-reader`; an existing unhealthy stack requires explicit diagnosis.

The shared schema follows the `origin/main` remote-tracking revision available at admission. Fetch origin before a proof when that reference needs updating. The manager freezes that revision, compares migration filenames and SHA-256 hashes with the proof checkout, and reads the database's applied versions under the lifecycle reservation. Shared startup supplies an empty application migration directory so retained volumes also reach this comparison before application SQL runs. Missing main migrations run sequentially, with each SQL file and its history entry in one transaction. A checkout with extra, changed or missing main migrations, or a database containing versions outside main, selects a dedicated local Supabase project instead. Dedicated projects use OS-selected ports; the selected configuration reaches the proof and its app processes. Release verifies the dedicated container identity, stops that project and retains its database volume and configuration. When `NOUS_E2E_DATA` identifies a proof, its dedicated ownership record also supports `bun run e2e/nous/stack.ts --stop` from the original worktree in a separate process. Shared adoption preserves the existing shutdown owner.

Each scenario uses the confirmed disposable account and project created by `e2e/nous/prepare.ts`, then runs its cleanup. Custom proofs follow the same preparation contract. Cleanup stops only the run's identity-verified app processes and releases its activity record. The shared database stays available. Activity records and the last-run stamp live in `~/.cache/nous-supabase`, with `NOUS_SHARED_SUPABASE_DATA` available for isolated manager tests. A shared lifecycle reservation serializes stack startup, admission, release and shutdown independently of host CPU slots. A hidden watcher queues a shutdown after 20 idle minutes, checks live run processes and verifies the database container identity. Only a stack started by this manager is eligible; adopted services retain their existing owner's shutdown policy.

`bun run deps:install` uses Bun's cache with hardlinks and a separate dependency tree per worktree. A matching installed tree takes Bun's incremental path; changed lockfiles install their own resolved dependencies. Run this command after creating a worktree or changing its lockfile.

Heavy commands share a FIFO counting semaphore across worktrees, with four concurrent slots by default. Set `HEAVY_RUN_SLOTS` to a positive integer to choose capacity, and add `--weight 2` after `--label "who/what"` for a command that needs two slots. The first waiting command enters when its full weight fits; later tickets wait behind it. Package scripts acquire and release slots automatically, and nested commands share their parent's reservation. Use `bun scripts/heavy-run.mjs status` to inspect all running owners, their weights and the waiting queue. Additional Docker proofs run through `bun scripts/heavy-run.mjs --label "who/what" --weight 2 -- <command...>`. The [queue wrapper](../../../scripts/heavy-run.mjs) owns admission, heartbeats, process-liveness checks and stale reservation recovery; CI bypasses local coordination.

## Final candidate

CI runs `gate:ci`: full `quality:ci` checks, dependency boundaries and the Fallow regression check, then one complete Node suite producing coverage. SonarQube Cloud analyzes that commit with its coverage report. Merge only when `test`, `SonarCloud Code Analysis` and applicable contract and PR-body checks are green on the proposed head. A new commit needs its own evidence. Resolve new Sonar findings with an owner-visible disposition before merging.

Fork PRs need trusted analysis on the proposed head because untrusted CI withholds the scanner secret. A passing test job without the required analysis does not satisfy that requirement.

## Diagnose Windows-specific failures

Use `bun run gate:full` for Windows diagnosis. It sequences checks, Node coverage and local Sonar. Keep heavy execution serialized and release the local service afterward with `bun run sonar:stop`. The [diagnostic guide](../../../docs/TESTING.md#diagnose-windows-specific-failures) owns setup and troubleshooting.

## Evaluate generated content

Provider-backed evaluations need a configured, authenticated provider and `NOUS_E2E_DATA` outside the repository. They incur provider usage and can capture full model exchanges, so keep manifests, source material and generated lessons in private evidence. Compare representative outputs and known failures across the providers supported by the changed flow.

Browser playtests use disposable accounts on the shared local stack and recorded scenarios. Inspect intermediate states and artifacts as well as the final result: navigation, reload and persisted state can reveal failures a static rendering test misses. Generated explanations also require content review against their objectives and evidence. Deterministic schema success establishes structure; the actual explanation establishes its reasoning.

Test directories include suites and their helper fixtures. The Vitest runner configuration is also test infrastructure; the application Vite configuration remains production source. The playback atlas capture page, fixtures, command and standalone browser contract are also Sonar test code. Their unit and headless contracts verify the harness; production archive readers retain source analysis and application coverage. `config/sonar-project.properties` owns this classification for both SonarCloud and local ESLint.
