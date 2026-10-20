---
title: "Testing and Quality Checks"
wiki_page_id: "p-testing-quality"
---

# Testing and Quality Checks

Use focused checks while a change is in progress. GitHub Actions runs the full CI suite for pull-request updates and pushes to the main branch. The local final gate checks the merge candidate after CI passes.

## Everyday checks

| Command | What it checks |
| --- | --- |
| `bun run quality` | TypeScript, formatting, lint and React Hooks checks. |
| `bun run test` | Automated tests under Bun. |
| `bun run quality:ci` | CI quality checks, including dependency boundaries. |
| `bun run gate:ci` | CI checks, dead-code baseline and the full Bun suite. |

Run the checks that cover the changed behavior while developing. On a resource-constrained machine, run one heavy analysis at a time. For the environment diagnostic, see [Command-line tools](03-p-cli-tools.md).

## Final local gate

After GitHub CI passes on the final commit, run `bun run gate:full` once. It runs `gate:ci` locally, including dependency checks, the Fallow baseline comparison and the full Bun suite, then Node 26 coverage and SonarQube analysis. SonarQube is a local merge gate; it is not part of GitHub Actions.

The command starts or reuses SonarQube before analysis and leaves it running afterward. Run `bun run sonar:stop` when you are finished with the service.

## Provider-backed evaluations

Some evaluations call a real AI provider and may incur usage costs. Configure and authenticate the provider first, then set `NOUS_E2E_DATA` to a directory outside the repository. Run evidence can contain generated lesson material and provider outputs, so keep it private and do not add it to source control.

## Browser playtests

Browser playtests check a learner’s path through the interface. Run them against an isolated test stack with test data, and review the captured screens and findings. Product data or private course material should not be copied into the repository as fixtures.

Automated checks cover structural contracts and repeatable behavior. Human review remains necessary when the question is whether a generated explanation or learner flow is clear.
