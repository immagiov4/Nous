# Change reports

Pull requests, issues, commit messages and status reports. The reader is busy, reviews several of these a day, and can read the code. They arrive looking, so there is no hook: the opening is the click (what problem, what result), then the approach, then only the pressing questions. They open the text to learn what changed and whether it worked, not how the work went.

## Pull request shape

Keep the visible part under about 200 words; a reviewer should get the point in ten seconds.

```markdown
**Problem:** one or two sentences from the issue, in user-visible terms. Closes #N.

**Approach:** two to four lines on what changed and why this way.

**Result:**
| | Before | After |
|---|---|---|
| Gate time | 16 min | 11 min |

<details><summary>Details</summary>

Anything a curious reviewer might want: edge cases, rejected alternatives, file map.

</details>

## Testing
- Short list: which standard suites passed, plus any check specific to this change.
```

- **Result** is the core. Performance work shows before/after numbers. A refactor shows a before/after diagram (Mermaid) of the affected structure. A UI change links before/after screenshots. A bug fix states the reproduction that failed before and passes now.
- **Testing** names suites, not commands and logs. Standard suites get one line together; only a check invented for this change gets its own line.
- Keep sections a repository requires (for example a merge-decision section), at one or two lines each.
- Leave out what the diff, the config or the commit history already shows: file-by-file changes, commands run, attempts, session narrative, tool and variable names the reviewer will not act on.

## Issues

Problem in user-visible terms, evidence (observed vs expected, with numbers or a screenshot), and the decision or outcome wanted. Investigation notes go in a collapsed details block.

## Commit messages

Subject says what changed; the body, if any, says why in a few lines.

## Status reports

Lead with the state (done, blocked, failed) and the number that matters; then the next step. One short paragraph or list.
