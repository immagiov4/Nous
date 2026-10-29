---
name: full-stop
description: Full stop on a Nous backlog batch. Same delegated, ledger-tracked PR loop as full send, but each PR stops at merge-ready for the user to merge. Use only when the user explicitly says full stop or invokes $full-stop.
---

# Full stop

Run [full-send](../full-send/SKILL.md) with one change: the merge belongs to the user. Each PR
reaches `merge-ready` (every gate green on the exact head, current `main` included, genuine findings
resolved) and its ledger row stops there. Report the merge-ready PR links together.
