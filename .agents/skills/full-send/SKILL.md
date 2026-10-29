---
name: full-send
description: Full send on a Nous backlog batch. Delegate each item, babysit its PR and merge it once the gates pass, tracked in a run ledger until every item is done. Use only when the user explicitly says full send or invokes $full-send; for full stop, see $full-stop.
---

# Full send

An explicit full-send request grants the high-throughput PR loop of
[orchestrate-nous-backlog](../orchestrate-nous-backlog/SKILL.md): delegated tasks commit, push,
open non-draft PRs, fix genuine review findings, and merge once that skill's merge gates pass. Under
`$full-stop` the same loop ends each PR at `merge-ready`, and the user merges. Run the steps through
orchestrate-nous-backlog; this file adds the authority and the finish line.

1. **Scope.** Take the issues the user named, or the newest batch they referred to. Run
   orchestrate-nous-backlog sections 1-2: current state, fresh `origin/main` (local `main` is
   aligned only when the user asks), issue map, lanes. Done when every selected issue has a lane.
2. **Ledger.** Create the run ledger with one row per work item (grouped by subsystem). Done when
   the file exists with every item and its lane.
3. **Ask once.** Send every `interactive` and `brainstorm` decision in one batch with a recommended
   option each, plus the desktop notice. Mark those rows `needs-user`.
4. **Dispatch.** Write the common brief, then start one Codex task per `autonomous` or
   `verification` group through the section 3 dispatch route, each with its Requirements map. A
   verification task proves the issue on current `main` and closes it with evidence
   (`closed-noop`), or fixes it through the same PR loop. Done when every such row has an owner and
   state `running`.
5. **Loop.** At every task notification, CI or review result, or user answer: read the ledger,
   handle the event (review the diff or PR, revive a stalled task, dispatch answered or queued items
   into freed capacity), and update the row. Run the orchestration health check at least every 20
   minutes. Stay in the loop while any row is non-terminal; end a turn only when every non-terminal
   row waits on a background task that will notify.
6. **Report.** When every row is terminal, report from the ledger: merged PRs, issues closed as
   already fixed, rows awaiting the user (with the question), and named blockers.
