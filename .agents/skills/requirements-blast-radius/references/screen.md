# Semantic screen

Semantic screening is on by default for substantial changes, always alongside lexical search and caller reading. Use the screen to prioritize source reading for a requirements map. Source sharing uses the project boolean, then the user boolean, then a verified public GitHub origin. An unverified origin with no recorded choice requires asking once for the user default. Its provider modes send every committed non-test source file to OpenRouter; check the source inventory first. Keep credentials in `OPENROUTER_API_KEY` in the child process environment. Supply it through the shell that launches the screen or a local secret manager. A repository may document that setup in an ignored environment file and explicitly export it before launch; the program reads only the process environment. Without the variable, provider modes report a skipped screen and return to lexical search and caller tracing. Inventory-only and grep modes work without it.

## Run

Python 3.10+ and Git are sufficient. Run the command while building the requirements map. Supply a plain-text request, the repository/revision, an external cache directory and an external output path:

```sh
node <adopt>/scripts/hook.mjs --current-turn --session <session-id>
python <skill>/scripts/screen.py --repo <repo> --ref HEAD --request-file <request.txt> --mode decisions --cache <cache-dir> --output <ranked.json> --session <session-id> --turn <turn-id>
```

Use the session ID from Geppetto's turn-record command. Run the first command from the repository root with `<adopt>` resolved to the installed Geppetto adoption skill. Pass its returned `turn` as `<turn-id>`. The screen vendored in Nous needs both IDs to produce a record the plugin can match to this turn.

Record the install answer with `python <skill>/scripts/screen.py --user --share-source yes` (or `no`). Use `--repo <repo> --share-source no` to override the default locally. The command selects the most recent standard Perplexity Decider from the OpenRouter Decisions catalog, caching the selection daily. Add `--model` to override. Provider runs record a `screenRun` ID and disposition without storing request text or source in the hook journal. Inventory-only and grep stay local. Only regular Git blobs from the selected commit are read; review current uncommitted work separately. Source suffixes and test-directory exclusions are explicit in `SOURCE_SUFFIXES` and `TEST_PARTS`. Run once with `--inventory-only` to inspect the manifest, including excluded paths, before provider calls. Add `--source-suffix .ext` for another source language; adjust the test layout classifier when needed. Completeness is relative to this explicitly enumerated source inventory. Submodules require a separate authorized scan.

`--mode chat --model <chat-model>` evaluates a model that generates a score and one-sentence reason. `--mode grep` runs the local lexical baseline with the same inventory. Decisions models return a yes probability and a selected reason category; the displayed category is a rubric label, not a generated explanation. Scores across models are not calibrated against each other.

Large files are divided into complete fixed character windows, with no content truncation. Each window receives the whole request. File rank uses its strongest window and deterministic path ordering for ties; inspect all tied candidates when a reading cutoff crosses a tie. The screen cannot infer a whole repository's call graph from isolated windows, so follow callers and shared representations after reading candidates.

## Results and recovery

The JSON result contains the revision, complete file/chunk counts, ranking, reasons, originating lines, errors, request cost reported by OpenRouter, including known charges for rejected scoring output, wall time and cached counts. Its sibling manifest lists each file hash and byte count. A partial scan exits nonzero and carries `complete: false`. Source exclusions and provider failures remain discovery gaps until resolved. When the provider omits a charge, retain its usable score and count the charge as unknown. Provider-side charges for failed requests can also be unknown.

The cache identity includes the versioned screening contract, model, complete request, path, chunk offset and chunk content. Increment `VERSION` when changing the scoring contract. Cache records contain scores, reasons and usage, so keep them outside the repository. `charged_usd` counts reported charges for requests issued in this run, including validation/cache failures with available usage; `uncached_equivalent_usd` sums recorded successful-request costs including reused entries. Aliases can change behind an unchanged model ID: pin a versioned catalog model and inspect the returned model build before reusing its cache.

Tune transport workers and character-window size against the provider's documented context and admission limits. The defaults are execution settings. Requests to free variants are paced at [OpenRouter's documented limit](https://openrouter.ai/collections/free-models#what-are-the-rate-limits-for-free-models). HTTP 503 receives up to two additional transport attempts with exponential backoff; --retries configures that count, and zero selects one attempt. Other HTTP failures remain terminal. Retried 503 responses count as unknown-charge errors because they provide no billing data; inspect errors and explicitly complete missing work at suitable parallelism. Retain each run's report before replacing an output file.

## Decide whether to keep it

Evaluate against historical requests on their pre-change revisions. Hold later failures and their file labels out of provider inputs. Compare top-20 and top-50 recall, target ranks and ties against lexical search plus the same lifecycle checklist; report the request provenance, inventory, completion, observed cost and single-run wall time. Separate independently confirmed missed files from ordinary affected-file controls. Run a similarity baseline when it could offer the same discovery more cheaply.

Keep the screen only when reading its candidates adds useful requirement discovery or materially improves the tested reading order. Preserve the requirements-map workflow with lexical search and caller tracing when the screen adds no demonstrated value. Source reading decides a requirement's disposition; ranking only chooses where to look.

## Install and check

Run `python <skill>/scripts/test_screen.py` for source-boundary, chunk-coverage, ranking, cache and installation checks. The installer removes legacy requirements prompt hooks, preserves unrelated settings and retains backups:

```sh
python <skill>/scripts/install.py --claude-home <claude-home> --codex-home <codex-home> --backup-dir <fresh-backup-dir>
```

For a repository install, run:

```sh
python <skill>/scripts/install.py --project <repo> --backup-dir <external-backup-dir>
```

Commit `.agents/skills/requirements-blast-radius/`, `.claude/skills/requirements-blast-radius/SKILL.md` and any removal of legacy hooks from `.claude/settings.json` and `.codex/hooks.json`. Codex discovers the canonical `.agents/skills` copy; the Claude entry point links to it. Global installs use the selected client homes (`CODEX_HOME` when configured). The Geppetto plugin handles prompt decisions through the [turn record](https://github.com/immagiov4/Geppetto/blob/v0.22.0/skills/geppetto-adopt/assets/templates/hooks/README.md#turn-record).

Run both `test_screen.py` and `test_project.py` to verify screening, installation, legacy hook removal and preservation of unrelated settings.
