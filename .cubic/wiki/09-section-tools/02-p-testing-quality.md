---
title: "Testing and merge evidence"
wiki_page_id: "p-testing-quality"
---

[Up one level](01-p-local-setup.md)

# Testing and merge evidence

Verification starts at the changed behavior and expands to the service boundaries it crosses. Focused deterministic tests establish repeatable contracts; database, provider and browser checks establish integrations their test doubles cannot cover. The required merge evidence is green CI on the exact PR head, including SonarCloud and applicable contract checks.

## During development

Local checks stay on changed files: run `bunx biome check --write <changed files>` and the targeted behavior tests for the code changed. Run `bun run lint:types` when types or interfaces change. These fast checks run directly, without the shared heavy-run lock; CI owns full-repository quality, tests, coverage and SonarCloud. The [quality workflow](../../../.agents/skills/quality-workflow/SKILL.md) describes verification depth for integrations and visual changes, while this page defines the local/CI split and merge requirement.

Route tests can use controlled stores and identities. Real Supabase checks exercise authentication, row-level security and PostgreSQL persistence with the local stack; `bun run test:supabase-local` runs the corresponding integration set. Workflow PostgreSQL contracts exercise durable execution and recovery. The [testing guide](../../../docs/TESTING.md) owns detailed prerequisites and specialized commands.

## Final candidate

CI runs `gate:ci`: full `quality:ci` checks, dependency boundaries and the Fallow regression check, then one complete Node suite producing coverage. SonarQube Cloud analyzes that commit with its coverage report. Merge only when `test`, `SonarCloud Code Analysis` and applicable contract and PR-body checks are green on the proposed head. A new commit needs its own evidence. Resolve new Sonar findings with an owner-visible disposition before merging.

Fork PRs need trusted analysis on the proposed head because untrusted CI withholds the scanner secret. A passing test job without the required analysis does not satisfy that requirement.

## Diagnose Windows-specific failures

Use `bun run gate:full` for Windows diagnosis. It sequences checks, Node coverage and local Sonar. Keep heavy execution serialized and release the local service afterward with `bun run sonar:stop`. The [diagnostic guide](../../../docs/TESTING.md#diagnose-windows-specific-failures) owns setup and troubleshooting.

## Evaluate generated content

Provider-backed evaluations need a configured, authenticated provider and `NOUS_E2E_DATA` outside the repository. They incur provider usage and can capture full model exchanges, so keep manifests, source material and generated lessons in private evidence. Compare representative outputs and known failures across the providers supported by the changed flow.

Browser playtests use an isolated stack and recorded scenarios. Inspect intermediate states and artifacts as well as the final result: navigation, reload and persisted state can reveal failures a static rendering test misses. Generated explanations also require content review against their objectives and evidence. Deterministic schema success establishes structure; the actual explanation establishes its reasoning.
