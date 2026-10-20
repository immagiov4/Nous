---
title: "Testing and Quality Checks"
wiki_page_id: "p-testing-quality"
---

[Up one level](01-p-local-setup.md)

# Verify a change

Start with checks that exercise the behavior you changed, then use the repository's quality checks. [The quality workflow](../../../.agents/skills/quality-workflow/SKILL.md) sets the required depth for a local fix, medium feature or larger visual change.

## During development

Run focused behavior tests and `bun run quality` for TypeScript, Biome, React Hooks and Sonar-style rules. Keep heavy analysis serialized on a resource-constrained host. [Command reference](03-p-cli-tools.md) lists the diagnostics; [the testing guide](../../../docs/TESTING.md) owns detailed setup and specialized checks.

## Final candidate

GitHub CI runs `gate:ci`: CI quality and Fallow checks, then one Node test execution producing coverage. After CI passes on the candidate, `gate:full` runs the same checks and coverage as separate stages, then starts or reuses SonarQube for analysis. It retains later stages after a failure and reports the failed stages together.

Use Node 26 for coverage. SonarQube stays running after the command; release it with `bun run sonar:stop` when finished. [AGENTS.md](../../../AGENTS.md#validation-commands) owns scan applicability and the documentation-only exception.

## Evaluate generated content

Provider-backed evaluations need a configured, authenticated provider and `NOUS_E2E_DATA` outside the repository. They can incur usage costs. Their local evidence includes manifests and full captured model exchanges; keep it private, especially when it contains source or lesson material.

Run browser playtests against an isolated stack and inspect the recorded learner path. Tests establish repeatable behavior; generated teaching explanations require content review too. Follow [the testing guide](../../../docs/TESTING.md) for provider harnesses, run capture and browser setup.
