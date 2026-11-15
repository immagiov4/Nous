---
name: code-review
description: "Redirect: the canonical code-review skill is the Geppetto plugin's code-review. Use it for every branch, PR or diff review."
---

# Code review (redirect)

Read and follow the Geppetto plugin's code-review skill at the newest installed version. In Codex, use `$geppetto:code-review` and the harness-provided skill discovery to locate its installed directory. If discovery exposes an older version, inspect the active harness's plugin cache and select the highest installed version by version number.

For Codex, locate the cache through the configured `CODEX_HOME` (default `~/.codex`), under `plugins/cache/<marketplace>/geppetto/<version>/skills/code-review/`. For Claude Code, use its discovered plugin directory or `~/.claude/plugins/cache/<marketplace>/geppetto/<version>/skills/code-review/`.

Read `SKILL.md` and resolve its relative links from the selected directory.
