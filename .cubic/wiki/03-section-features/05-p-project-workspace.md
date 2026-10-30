---
title: "Saving and exporting a changing project"
wiki_page_id: "p-project-workspace"
---

[Up one level](../04-section-data/01-p-database-schema.md)

# Saving and exporting a changing project

A lesson can finish generating while the browser still holds an earlier copy of its project. If the browser then saves that copy over the generated result, the new lesson would be lost. Nous prevents this by checking which revision the browser edited before accepting its replacement.

## Keep newer work when a browser saves

Suppose the browser loaded revision 7 and lesson generation then committed revision 8. The browser's next save still names revision 7, so the backend rejects it and keeps revision 8. The client must obtain the newer project and reload or reconcile its changes before saving again. This is why even a single browser can encounter a revision conflict: background generation is another writer.

The check and the project replacement belong to the same database transaction. That lets the backend reject a stale replacement before it commits new content or changes the associated file references. The common commit implementation lives in [project revision writes](../../../apps/backend/src/projects/projectRevisionWrite.ts).

[Source ingestion](03-p-doc-processing.md#prepare-files-before-publishing-their-source-set) uses the same ownership and revision boundary when publishing prepared sources. The repository receives a destination snapshot and revision, while the ingestion module owns file expansion, transfer and preparation; a metadata-only save retains its ordinary snapshot contract.

## Retry a failed interview from its saved draft

Interview startup saves a draft before waiting for the interview. If startup fails, the draft retains its prepared sources and original objective, so reopening it can retry after a browser reload. Hydrated source text serves the interview request; persistence keeps the source references needed to recover it. A failed startup or unsuccessful navigation preserves that preparation.

A successful reopen adopts the recovered interview. Older overlapping starts and retries must preserve that run and leave the newer workspace usable. Superseded operations omit obsolete warnings; explicit Stop retains cancellation and draft-cleanup ownership. The [workspace controller](../../../apps/web/hooks/workspace/controller/assessmentPlanning.ts) coordinates interview startup with [project opening](../../../apps/web/hooks/workspace/controller/projectLifecycle.ts).

## Build an export from one set of versions

An export has the same consistency problem over a longer period. It reads project data and prepares the files needed to restore it; a project changing halfway through could otherwise leave the archive combining different versions. A library export therefore records the project revisions it starts from and fails the attempt if one of them changes. Retrying begins a fresh snapshot.

Preparing a whole library can also outlive a server process. The export records completed project archives as it goes, so a restart can resume that attempt instead of discarding its preparation. Those checkpoints preserve progress, while the revision checks preserve the consistency of the result.

For the files an archive must carry and how restoration reconnects them, continue with [asset adoption and cleanup](../04-section-data/02-p-asset-management.md). [Deployment backups](../08-section-deployment/01-p-self-hosted.md#back-up-and-restore) cover recovery of the installation rather than a portable set of projects.

## Observability

The [project routes](../../../apps/backend/src/routes/projects.ts) report revision conflicts as HTTP 409 with an error code. [Library export](../../../apps/backend/src/projects/libraryExport.ts) exposes persisted progress and logs checkpoints, completion and failure with the export run, phase and elapsed time. The [database contract tests](../../../apps/backend/tests/projects/libraryExportRunStore.integration.test.ts) cover restart persistence and rejection of stale completion. These signals locate a rejected save or interrupted export; they do not explain the semantic differences between competing project edits.

Interview startup traces identify preserved drafts and safe failure metadata; abandoned starts suppress stale source warnings. [Controller regressions](../../../apps/web/tests/hooks/workspace/useWorkspaceController.test.ts) verify overlapping opens, Stop and answerability of adopted runs. The [Chromium recovery proof](../../../e2e/nous/tests/interviewRecovery.browser.ts) verifies that a failed startup survives reload with the same objective, sources and project identity. These checks establish recovery behavior; they do not identify the cause of a historical provider failure.
