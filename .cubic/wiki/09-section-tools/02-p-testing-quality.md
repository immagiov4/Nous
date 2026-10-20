---
title: "Verify a change"
wiki_page_id: "p-testing-quality"
---

[Up one level](01-p-local-setup.md)

# Verify a change

Start with checks that exercise the behavior you changed, then use the repository's quality checks. [The quality workflow](../../../.agents/skills/quality-workflow/SKILL.md) sets the required depth for a local fix, medium feature or larger visual change.

## During development

Run focused behavior tests and `bun run quality` for TypeScript, Biome, React Hooks and Sonar-style rules. Keep heavy analysis serialized on a resource-constrained host. [Command reference](03-p-cli-tools.md) lists the diagnostics; [the testing guide](../../../docs/TESTING.md) owns detailed setup and specialized checks.

## Final candidate

GitHub CI checks out the exact pull-request head and runs `gate:ci`: CI quality and Fallow checks, then one Node test execution producing coverage. Same-repository pull requests and main pushes also run SonarQube Cloud analysis; a failed scan or quality gate fails the job. Fork pull requests run checks and coverage without the authenticated scan.

The local merge gate also applies under [AGENTS.md](../../../AGENTS.md#validation-commands). After CI passes on the candidate, `gate:full` runs the checks and coverage as separate stages, then starts or reuses local SonarQube for analysis. It retains later stages after a failure and reports them together. Cloud and local comparison uses the same commit, coverage, issue scope and gate conditions; the maintainer owns any change to that requirement.

Use Node 26 for coverage. SonarQube stays running after the command; release it with `bun run sonar:stop` when finished. [AGENTS.md](../../../AGENTS.md#validation-commands) owns scan applicability and the documentation-only exception.

## Evaluate generated content

Provider-backed evaluations need a configured, authenticated provider and `NOUS_E2E_DATA` outside the repository. They can incur usage costs. Their local evidence includes manifests and full captured model exchanges; keep it private, especially when it contains source or lesson material.

Run browser playtests against an isolated stack and inspect the recorded learner path. Tests establish repeatable behavior; generated teaching explanations require content review too. Follow [the testing guide](../../../docs/TESTING.md) for provider harnesses, run capture and browser setup.
