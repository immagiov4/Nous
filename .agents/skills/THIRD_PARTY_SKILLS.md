# Third-party skills

These skills are vendored under their original MIT licences; each folder keeps its `LICENSE`.

| Skills | Source | Licence |
| --- | --- | --- |
| `architect` (adapted for this environment), `benchmark-checklist`, `how`, `show-me-your-work`, `why`, `principle-*` | [cursor/plugins `pstack`](https://github.com/cursor/plugins/tree/main/pstack) by Lauren Tan | MIT |
| `write-pr` (adapted; upstream credits Dex Horthy / Humanlayer show-me) | [mattpocock/skills pr](https://github.com/mattpocock/skills/tree/main/skills/engineering/pr) by Matt Pocock | MIT |
| `codebase-design`, `improve-codebase-architecture` (adapted for this environment), `domain-modeling`, `grilling` | [mattpocock/skills](https://github.com/mattpocock/skills) by Matt Pocock | MIT |
| `elegant-code` | [OleksandrKucherenko/e-bash](https://github.com/OleksandrKucherenko/e-bash/tree/master/.claude/skills/elegant-code) by Oleksandr Kucherenko | MIT |

Local adaptations: `principle-sequence-verifiable-units` replaces its automatic rebase with a read-only freshness check, because AGENTS.md forbids unapproved state-changing Git commands. The upstream `disable-model-invocation: true` frontmatter is removed because the Codex skill validator rejects it; the vendored `principle-*` copies use `agents/openai.yaml` with `allow_implicit_invocation: false` and remain explicitly invocable. The installed `my-codex-skills:principle-*` skills own automatic selection, so cloud setup exposes one automatic copy per principle. Other adapted skills retain their own invocation policies. `show-me-your-work` mentions the pstack `unslop` writing-style skill as optional advice; it is not vendored.

## Precedence in this repository

Vendored skills are guidance written for other environments. Where one conflicts with AGENTS.md or a repository-local skill, AGENTS.md and the local skill win. In particular:

- **Git state:** creating worktrees, branches, rebases, merges, commits or pushes needs the repository's Git authorization; use temporary directories for candidate work otherwise.
- **Scope of a request:** a design-only request ("design this", "architect this") stops after presenting the design; implementation needs explicit intent.
- **Documentation scope:** apply AGENTS.md's Cubic Wiki Governance to every documentation step, including system-map maintenance.
- **Documentation location:** do not create new documentation structures such as a root `GLOSSARY.md` or `docs/adr/`; architecture documentation belongs in `.cubic/wiki`, per AGENTS.md.
- **Numbers:** file-size cutoffs, timeouts and other numeric thresholds in vendored skills are not project policy; the maintainer sets thresholds from measured data.
- **Agents, models and tools:** use the delegation tools available in the current environment and the model policy in AGENTS.md and the maintainer's instructions, not Cursor-specific model slugs, rule files or tools. Work that edits files runs as separate visible delegated tasks, as AGENTS.md requires.
- **Work logs:** decision logs and other run artifacts that are not meant to be committed go to the OS temporary directory, never inside the repository tree.
- **Missing inputs:** when a vendored step needs an artifact the environment does not expose (for example agent transcripts), use the closest available evidence and say what was unavailable.
- **Testing:** the testing rules in AGENTS.md and `quality-workflow` govern; an assertion such as an empty result is valid when it is the precise observable contract.

## Automatic principle selection

Apply the installed principle when its task condition matches. Evaluate the benefit as applicable tasks completed without a maintainer reminder to invoke a principle, using task transcripts to identify missed selections. The counter-metrics are irrelevant or duplicate invocations per task and context bytes consumed by selected principles. Compare these against explicit-only sessions before claiming a workflow improvement; behavioral comparison remains pending. The setup pin and invocation metadata prove eligibility and a single automatic owner, not selection quality.
