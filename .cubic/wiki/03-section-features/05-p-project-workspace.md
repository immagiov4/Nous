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

## Build an export from one set of versions

An export has the same consistency problem over a longer period. It reads project data and prepares the files needed to restore it; a project changing halfway through could otherwise leave the archive combining different versions. A library export therefore records the project revisions it starts from and fails the attempt if one of them changes. Retrying begins a fresh snapshot.

Preparing a whole library can also outlive a server process. The export records completed project archives as it goes, so a restart can resume that attempt instead of discarding its preparation. Those checkpoints preserve progress, while the revision checks preserve the consistency of the result.

For the files an archive must carry and how restoration reconnects them, continue with [asset adoption and cleanup](../04-section-data/02-p-asset-management.md). [Deployment backups](../08-section-deployment/01-p-self-hosted.md#back-up-and-restore) cover recovery of the installation rather than a portable set of projects.
