# Semantic screen

Use the screen to prioritize source reading for a requirements map. Run it after checking the repository's data-sharing rules. Its provider modes send every committed non-test source file to OpenRouter; review the source inventory and authorization first. Keep credentials in `OPENROUTER_API_KEY` in the child process environment. Supply it through the shell that launches the screen or a local secret manager. A repository may document that setup in an ignored environment file and explicitly export it before launch; the program reads only the process environment. Without the variable, provider modes report a skipped screen and return to lexical search and caller tracing. Inventory-only and grep modes work without it.

## Run

Python 3.10+ and Git are sufficient. Supply a plain-text request, the public repository/revision, an external cache directory and an external output path:

```sh
python <skill>/scripts/screen.py --repo <repo> --ref HEAD --request-file <request.txt> --mode decisions --model perplexity/pplx-decider-flash-v1.2 --public-code --cache <cache-dir> --output <ranked.json>
```

`--public-code` records the caller's verification that the committed source is authorized for transmission. Only regular Git blobs from the selected commit are read; review current uncommitted work separately. Source suffixes and test-directory exclusions are explicit in `SOURCE_SUFFIXES` and `TEST_PARTS`. Run once with `--inventory-only` to inspect the manifest, including excluded paths, before provider calls. Add `--source-suffix .ext` for another source language; adjust the test layout classifier when needed. Completeness is relative to this explicitly enumerated source inventory. Submodules require a separate authorized scan. Private repositories require a separately authorized transmission workflow.

`--mode chat --model <chat-model>` evaluates a model that generates a score and one-sentence reason. `--mode grep` runs the local lexical baseline with the same inventory. Decisions models return a yes probability and a selected reason category; the displayed category is a rubric label, not a generated explanation. Scores across models are not calibrated against each other.

Large files are divided into complete fixed character windows, with no content truncation. Each window receives the whole request. File rank uses its strongest window and deterministic path ordering for ties; inspect all tied candidates when a reading cutoff crosses a tie. The screen cannot infer a whole repository's call graph from isolated windows, so follow callers and shared representations after reading candidates.

## Results and recovery

The JSON result contains the revision, complete file/chunk counts, ranking, reasons, originating lines, errors, request cost reported by OpenRouter, including known charges for rejected scoring output, wall time and cached counts. Its sibling manifest lists each file hash and byte count. A partial scan exits nonzero and carries `complete: false`. Source exclusions and provider failures remain discovery gaps until resolved. Provider-side charges for failed requests are unavailable in this report.

The cache identity includes the versioned screening contract, model, complete request, path, chunk offset and chunk content. Increment `VERSION` when changing the scoring contract. Cache records contain scores, reasons and usage, so keep them outside the repository. `charged_usd` counts reported charges for requests issued in this run, including validation/cache failures with available usage; `uncached_equivalent_usd` sums recorded successful-request costs including reused entries. Aliases can change behind an unchanged model ID: pin a versioned catalog model and inspect the returned model build before reusing its cache.

Tune transport workers and character-window size against the provider's documented context and admission limits. The defaults are execution settings, not product policy. The script makes one attempt per uncached window; inspect errors and explicitly complete missing work at suitable parallelism. Retain each run's report before replacing an output file.

## Decide whether to keep it

Evaluate against historical requests on their pre-change revisions. Hold later failures and their file labels out of provider inputs. Compare top-20 and top-50 recall, target ranks and ties against lexical search plus the same lifecycle checklist; report the request provenance, inventory, completion, observed cost and single-run wall time. Separate independently confirmed missed files from ordinary affected-file controls. Run a similarity baseline when it could offer the same discovery more cheaply.

Keep the screen only when reading its candidates adds useful requirement discovery or materially improves the tested reading order. Preserve the requirements-map workflow with lexical search and caller tracing when the screen adds no demonstrated value. Source reading decides a requirement's disposition; ranking only chooses where to look.

## Install and check

Run `python <skill>/scripts/test_screen.py` for source-boundary, chunk-coverage, ranking, cache and installation checks. The installer merges its hook into existing settings and retains backups:

```sh
python <skill>/scripts/install.py --claude-home <claude-home> --codex-home <codex-home> --backup-dir <fresh-backup-dir>
```

For a repository install, run:

```sh
python <skill>/scripts/install.py --project <repo> --backup-dir <external-backup-dir>
```

Commit `.agents/skills/requirements-blast-radius/`, `.claude/skills/requirements-blast-radius/SKILL.md`, `.claude/settings.json` and `.codex/hooks.json`. If `.claude/` is ignored, allowlist those two Claude paths; keep `settings.local.json` ignored. Codex discovers the canonical `.agents/skills` copy. The Claude entry point links to that same copy. Re-running the installer updates it in place and preserves unrelated settings and hooks; an existing backup directory retains the initial backup. Omit `--backup-dir` to use a fresh OS temporary directory; the installer prints its location.

The prompt hook runs with Bun from the repository root or its subdirectories on Windows, macOS and Linux, resolving project commands from the nearest Git root for project installs. It reads stdin and local hook declarations, writes context to stdout, and performs no network calls or subprocess launches. When both levels are installed, the global hook yields to a declared project hook for that client; the repository version supplies the instruction and explicitly names its canonical skill path. The global skill also routes to that path when selected, because clients resolve same-name skills differently. A skill folder without a matching hook declaration leaves global injection active. Global installs use the selected client homes (`CODEX_HOME` when configured).

Client hook review/trust remains under the client's documented mechanism. Codex's `/hooks` reviews newly installed definitions. Run both `test_screen.py` and `test_project.py` to check source screening, installation, preservation and combined global/project injection.
