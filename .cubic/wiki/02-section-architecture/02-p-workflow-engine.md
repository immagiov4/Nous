---
title: "Workflow Engine"
wiki_page_id: "p-workflow-engine"
---

# Workflow Engine

Nous uses PostgreSQL to keep track of long-running work such as course and lesson generation. A saved run records what work remains, what has finished, and what needs attention after a restart.

## Starting work safely

A request key identifies a caller’s request. If the same request arrives again, the system can return the existing run rather than start a duplicate. A separate deduplication key can connect callers to work that is already active.

Run creation saves the run and its initial work in one database transaction. A notification wakes workers after the transaction commits; the saved run remains the source of truth if a notification is missed.

## Workers and retries

Workers claim individual steps for a limited time. Each claim receives a newer token, so a worker whose lease has expired cannot overwrite the result from a newer worker.

Completed provider results can be reused when the workflow saves them before continuing. If a process stops before saving a result, the provider call may happen again. Any repeated file writes must therefore be safe to repeat.

The workflow checks saved results against the expected data shape. When that shape changes, the workflow owner must also update the result’s identity so an older result cannot be mistaken for the new contract.

## Changes while work is saved

A run keeps the workflow definition it started with. It can continue after an update only while that definition remains registered as supported. Removing it, or removing a required provider, marks the active run as failed.

Definition checks compare the saved workflow structure. They do not prove that the behavior inside every step stayed the same, so changes to step behavior still need review and relevant coverage.

## Events and privacy

The event history records run creation, claims, retries, waits, completion, failure, cancellation and recovery. Support views may show a correlation code and a brief, sanitized failure description.

Workflow diagnostics exclude prompts, source material, provider payloads and credentials.
