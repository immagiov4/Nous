---
title: "Durable workflow execution"
wiki_page_id: "p-workflow-engine"
---

[Up one level](01-p-architecture.md)

# Durable workflow execution

Generation can involve several slow provider calls before a lesson is ready. Keeping that work only in memory would lose its position when the server restarts. Nous instead saves the workflow plan, pending steps and completed results in PostgreSQL; workers claim the saved work and continue from its committed progress.

## Save progress with the result it describes

Creating a run saves its initial work in the same transaction. After commit, a notification wakes workers; if that notification is missed, the work still exists in the database. Repeated requests can reconnect to an existing run through a request key, while a separate deduplication key can share active work between callers.

A completed step can save its domain mutation together with workflow persistence through the supplied transaction. When that mutation is a lesson replacement, this keeps the project's accepted content and the step's recorded result at the same commit boundary. A resumed worker can then use the saved result instead of repeating a completed step.

## Prevent an expired worker from committing

A worker holds a step for a limited lease. If it stops responding and another worker claims the step, the first worker may still finish its provider call afterward. Increasing fencing tokens distinguish those claims: completion must present the current token, so the expired worker cannot overwrite the newer claim's result.

This protects database commits, but an external provider call has its own lifetime. A crash after a paid call and before saving its response can cause that call to run again on resume. File preparation must tolerate these replay paths too; [asset ownership](../04-section-data/02-p-asset-management.md) distinguishes provisional output from files already adopted by a project.

## Resume against a compatible definition

A saved position only makes sense against the workflow definition that produced it. Active runs retain that definition's identity, and the registry keeps validated definitions with structural fingerprints for later lookup. Definitions and required providers must remain registered while their runs may resume.

The fingerprint covers serialized topology and schemas, including ordered schema arrays. A callback's implementation can change without changing that structure, so compatibility also needs behavioral tests. Use [definition validation](../../../apps/backend/src/workflows/validation.ts) and [schema fingerprints](../../../apps/backend/src/workflows/schemaFingerprint.ts) when changing this boundary; the [course and lesson definitions](../../../apps/backend/src/workflows/) show the domain steps it protects.
