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

Merge only when CI is green on the exact pull-request head, including `test`, `SonarCloud Code Analysis`, and the applicable contract and pull-request-body checks. Each new commit needs its own passing checks. Resolve every new Sonar finding with an owner-visible disposition before merging.

CI runs `gate:ci`: quality and Fallow checks, then one complete Node suite producing coverage. SonarQube Cloud analyzes that commit and uses its coverage report. Fork pull requests need a trusted analysis on the proposed head because CI withholds the scanner secret.

## Diagnose a Windows-specific failure

Use `bun run gate:full` for Windows diagnosis. It runs checks, Node coverage and local Sonar sequentially. Run one heavy analysis at a time and release the service afterward with `bun run sonar:stop`. The [testing guide](../../../docs/TESTING.md#diagnose-windows-specific-failures) owns diagnostic setup and details.

## Evaluate generated content

Provider-backed evaluations need a configured, authenticated provider and `NOUS_E2E_DATA` outside the repository. They can incur usage costs. Their local evidence includes manifests and full captured model exchanges; keep it private, especially when it contains source or lesson material.

Run browser playtests against an isolated stack and inspect the recorded learner path. Tests establish repeatable behavior; generated teaching explanations require content review too. Follow [the testing guide](../../../docs/TESTING.md) for provider harnesses, run capture and browser setup.
