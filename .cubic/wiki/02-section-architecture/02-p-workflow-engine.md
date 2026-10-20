---
title: "How saved workflows run"
wiki_page_id: "p-workflow-engine"
---

[Up one level](01-p-architecture.md)

# How saved workflows run

A run stores its remaining steps and completed results in PostgreSQL. Workers resume from that saved state after interruption, which lets the app report progress independently of the request that started the work.

## Start and claim work

A request key lets a repeated request return its existing run. A separate deduplication key can connect callers to active work. Creation saves the run and its initial work in one transaction; a notification wakes workers after commit, while the saved record survives a missed notification.

Workers claim steps for a limited time. Each claim receives a newer token so an expired worker cannot overwrite a newer worker's result.

## Reuse completed results

A provider result can be reused after the workflow saves it. Interruption before that save can repeat the call, so file writes must be safe to repeat. Saved results are checked against their expected shape; changing that contract requires changing its result identity too.

## Change a running definition

A run retains its starting definition. It resumes only while that definition and its required providers remain registered. Removing either fails the active run. Definition checks compare saved structure; step behavior still requires review and tests.

To investigate a run, use [workflow events and usage](../06-section-backend/05-p-telemetry-usage.md). To change its learning steps, start with [course generation](../03-section-features/01-p-course-gen.md) or [lesson generation](../03-section-features/02-p-lesson-gen.md).
