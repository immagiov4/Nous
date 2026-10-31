---
name: write-pr
description: "Draft or revise a Nous pull-request body using the portable PR procedure and the repository's format, evidence and validation contract."
---

# Write a Nous PR

Use `$my-codex-skills:write-pr` for drafting and evidence selection, with this project contract. If the installed skill is unavailable, read its [published source](https://github.com/immagiov4/my-codex-skills/blob/4ce5ba501e90429e8f39dd19049f1dd7ac1d6893/skills/write-pr/SKILL.md). The maintainer's explicitly selected alternative takes precedence for procedure; retain the repository's validators and agreed format. Writing for Humans or the selected simplifier refines language, while the PR procedure owns format and evidence.

## Nous contract

- Open with separate **Problem:**, **Approach:** and **Result:** paragraphs in that order. Keep at most 200 visible words outside collapsed Details. Describe the actual result; for a trivial change whose Approach is clear, a sentence is enough. Comparisons are optional when useful; prefer `Before | → After`. Say **Not measured** when a missing measurement limits a claim.
- Put screenshots or video under Result, after any comparison table and before Observability. Show visible changes with inspected artifacts, structure with the smallest useful diagram/tree/diff and behaviour with actual run evidence, following the portable procedure. Use durable reviewer-accessible links and preserve private inputs.
- Include `## 👁️ Observability` and `## 🧪 Testing`, with icons before the titles and plain body text. Observability identifies how to inspect the change and its material blind spots. Testing names relevant suites and results; keep CI and SonarCloud status together on one line, tied to the tested head.
- When material, place `## Merge impact` last, after Testing and supporting Details. Explain reversibility and affected scope concretely. Use `## ⚠️ Merge impact` when difficult to reverse. Routine reversible edits need no risk section.

## Validate and publish

Run `bun run github:body -- validate --kind pr --body-file <path>` and `node <adopt>/scripts/gate-sections.mjs --pr <path>`, resolving `<adopt>` from the installed Geppetto geppetto-adopt skill. These enforce syntax, required sections, nonempty Result and word count; review evidence adequacy and link access separately.

Before authorized publication, run `bun run github:body -- preview --repo immagiov4/Nous --body-file <path>`. Publish with `--body-file`, verify the remote body through `github:body verify`, and use `github:body update` for later revisions. Complete when the body passes both validators and the rendered result supports its claims. A local draft can finish with publication pending.

## Attribution and portable owner

The portable procedure lives in [My Codex Skills write-pr](https://github.com/immagiov4/my-codex-skills/tree/4ce5ba501e90429e8f39dd19049f1dd7ac1d6893/skills/write-pr). It adapts [Matt Pocock's pr skill](https://github.com/mattpocock/skills/blob/main/skills/engineering/pr/SKILL.md), MIT, which credits Dex Horthy / Humanlayer [show-me](https://github.com/humanlayer/skills/blob/main/plugins/show-me/skills/show-me/SKILL.md). See [LICENSE](LICENSE). Nous owns this contract and its commands; Geppetto resolves host policy and suggests the portable procedure only when the maintainer has selected no alternative.
