---
title: "Development diagnostics and publishing checks"
wiki_page_id: "p-cli-tools"
---

[Up one level](01-p-local-setup.md)

# Development diagnostics and publishing checks

The diagnostic commands inspect environment prerequisites separately from starting the application or running tests. This makes them useful when setup stops before the frontend and backend are ready. The report identifies missing runtime, tool or service requirements so the next action can target that boundary.

| Command | Inspection scope |
| --- | --- |
| `bun run doctor` | Runtime, installed tools and the Fallow baseline. |
| `bun run doctor -- --profile gate` | Local SonarQube readiness for Windows diagnosis. |
| `bun run doctor -- --profile local` | Local Supabase services and migration parity. |
| `bun run doctor -- --profile all` | Default checks and both service profiles. |

[scripts/doctor.ts](../../../scripts/doctor.ts) owns these checks. The diagnostic itself does not start services, change configuration or execute tests. Return to [local setup](01-p-local-setup.md) for service startup or [testing](02-p-testing-quality.md) for behavior evidence after resolving the reported prerequisite.

## Review bodies are rendered artifacts

The repository's GitHub-body helper validates a Markdown file before publication, then compares the published raw body with the reviewed file and checks GitHub-rendered HTML. This catches flattened Markdown or a remote body that differs from the reviewed file. Keep the body in a file so shell quoting does not become part of its formatting.

```bash
bun scripts/github-body.mjs validate --kind pr --body-file body.md
bun scripts/github-body.mjs preview --repo immagiov4/Nous --body-file body.md
bun scripts/github-body.mjs update --kind pr --repo immagiov4/Nous --number 123 --body-file body.md
bun scripts/github-body.mjs verify --kind pr --repo immagiov4/Nous --number 123 --body-file body.md
```

PRs open with **Problem:**, **Approach:** and **Result:**, followed by `## Testing`. Result includes a Before/After table, screenshot link, or "Not measured". The visible-word limit is 200; `<details>` holds supporting notes. Repository Claude and Codex shell hooks validate literal PR publication bodies before execution; unreadable shell expansions require a literal body file. CI and SonarCloud status share one Testing line.

`verify` reads the published artifact; `update` publishes the file and performs the same verification. Use `--kind issue` for an issue. The helper's check proves body identity and rendering, while [CI and review](02-p-testing-quality.md) establish the change's merge evidence.

## Capture the production playback stage

The playback atlas renders normalized lessons through the isolated production stage in headless Chromium, sampling each spoken block at its start, middle and end. The requested viewport is the stage’s available box; application playtests cover the player header, controls and audio interactions. Separate visual sheets cover authored figures that those positions could miss. The default input is a deterministic pairwise matrix over content, visual and scene types and Markdown syntax; a short synthetic course gives a smaller first run.

```bash
bun run atlas:playback -- --synthetic synthetic-short
bun run atlas:playback -- --fixture path/to/project.nous.zip
bun run atlas:playback -- --library "$NOUS_E2E_LIBRARY"
bun run atlas:playback -- --scenario path/to/playback-scenario.json
```

Each sample starts in an isolated browser context with a fixed clock and seeded randomness, including embedded visual documents. Font and image readiness precede capture; archived PDF figures use the application's asset readers. A parent process terminates a renderer that exceeds the measured execution bound, records incomplete evidence and opens a fresh renderer for the next sample. `--render-timeout-ms` overrides that bound. `--course` and `--lesson` select exact IDs; `--source-root` selects another installed source checkout for a version comparison.

The local `index.html` links labelled sheets to original PNGs and a structured report with source revisions, preparation fingerprints, geometry, execution durations and findings. Empty content, clipping, missing spoken math, caption boundaries and render errors are structural checks; mathematical meaning and visual quality require artifact review. Sparse content, fitted font size and canvas occupancy remain measurements rather than quality cutoffs. Findings make the command exit unsuccessfully, while failed or missing captures remain explicitly incomplete.

Evidence contains lesson content and stays outside Git. POSIX output uses owner-only directories and files; Windows output must resolve inside the user's profile and inherit its permissions. Private library input is refused in CI, and the browser blocks outbound requests. The [atlas command](../../../e2e/nous/playbackAtlas.ts) owns capture and evidence; `bun run test:atlas:browser` checks repeatability, scripted visuals, termination, archived images and clipping with synthetic fixtures.
