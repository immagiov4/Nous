# Third-party skills

These skills are vendored under their original MIT licences; each folder keeps its `LICENSE`.

| Skills | Source | Licence |
| --- | --- | --- |
| `architect` (adapted for this environment), `arena`, `benchmark-checklist`, `how`, `interrogate`, `show-me-your-work`, `why`, `principle-*` | [cursor/plugins `pstack`](https://github.com/cursor/plugins/tree/main/pstack) by Lauren Tan | MIT |
| `codebase-design`, `improve-codebase-architecture` (adapted for this environment), `domain-modeling`, `grilling` | [mattpocock/skills](https://github.com/mattpocock/skills) by Matt Pocock | MIT |
| `elegant-code` | [OleksandrKucherenko/e-bash](https://github.com/OleksandrKucherenko/e-bash/tree/master/.claude/skills/elegant-code) by Oleksandr Kucherenko | MIT |

Local adaptations: `principle-sequence-verifiable-units` replaces its automatic rebase with a read-only freshness check, because AGENTS.md forbids unapproved state-changing Git commands. Skills whose upstream frontmatter sets `disable-model-invocation: true` also carry `agents/openai.yaml` with `allow_implicit_invocation: false` so Codex applies the same explicit-invocation policy. `show-me-your-work` mentions the pstack `unslop` writing-style skill as optional advice; it is not vendored.
