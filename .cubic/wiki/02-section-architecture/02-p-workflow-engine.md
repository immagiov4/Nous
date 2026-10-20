---
title: "Durable workflow execution"
wiki_page_id: "p-workflow-engine"
---

[Up one level](01-p-architecture.md)

# Durable workflow execution

A workflow records its plan, pending work and completed step results in PostgreSQL. Workers execute that saved plan under leases, so a server restart can resume work without relying on a browser connection or an in-memory queue. The durability boundary is a committed result, including the identity of the definition that produced it.

## Create, claim and commit

Run creation saves the run and its initial work in one transaction. A request key reconnects a repeated request to its existing run; a separate deduplication key can connect callers to active work. A post-commit notification wakes workers, while the database record remains available when a notification is missed.

Workers claim steps for a limited time and receive increasing fencing tokens. Completion must present the current token, preventing an expired worker from overwriting work claimed by another worker. A step can commit its domain mutation with workflow persistence through the supplied transaction. This matters when saving a lesson: progress and project state need an explicit commit boundary.

## Replay has a defined limit

Saved provider results are reusable on resume. A crash after a paid call but before its result is saved can repeat the external call; durable execution therefore does not imply exactly-once provider billing. File operations and domain writes must tolerate the supported replay paths, with [asset ownership](../04-section-data/02-p-asset-management.md) distinguishing provisional output from adopted files.

Sequences, branches, fan-out, repeat decisions and signals describe the workflow topology. Result schemas validate step boundaries, and durable events publish committed changes. [Events and usage](../06-section-backend/05-p-telemetry-usage.md) help trace these transitions, while the saved run state establishes its outcome.

## Definitions are compatibility boundaries

The registry indexes validated definitions and their structural fingerprints. Registration builds the reusable definition metadata; lookups resolve a registered workflow and fingerprint rather than rebuilding that metadata for each lookup. Active runs retain the definition identity they started with, so compatible definitions and required providers must remain registered for resumption.

Fingerprints cover serialized structure and schemas, including ordered schema arrays where order matters. Callback behavior still requires behavioral tests: the same topology cannot prove that a changed implementation preserves meaning. Inspect [definition validation](../../../apps/backend/src/workflows/validation.ts) and [schema fingerprints](../../../apps/backend/src/workflows/schemaFingerprint.ts) when changing compatibility. Course and lesson definitions under [workflows](../../../apps/backend/src/workflows/) show how domain services plug into this execution model.
