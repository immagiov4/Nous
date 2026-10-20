---
title: "Project revisions and portable exports"
wiki_page_id: "p-project-workspace"
---

[Up one level](../04-section-data/01-p-database-schema.md)

# Project revisions and portable exports

A project groups a course, its generated content and study state under an owner and revision. Library records describe folders and project placement separately, allowing the library to load without fetching every lesson. Project saves and exports both rely on revision identity, but they use it for different purposes.

## Concurrent changes remain explicit

A client saving a project supplies the revision it edited. A stale revision produces a conflict instead of silently overwriting another session's save. The client must reload or reconcile against the authoritative version. Generation also commits project changes, so revision handling matters even when only one browser is open.

Folder operations update library organization without changing the course's lesson meaning. Deleting a folder moves its contents to the parent while retaining its projects. The separation between project snapshots and library placement lets these operations remain independent of lesson generation.

## An export is a snapshot attempt

A project archive combines saved data with the files needed for restoration. A library export prepares project archives in sequence and records its progress durably across server restarts. It identifies the project versions it is preparing; a project changing during preparation invalidates the attempt rather than quietly producing an archive assembled from different versions. A retry starts a fresh library snapshot.

The server verifies prepared output before the browser downloads it. This establishes the generated artifact, while delivery to a particular device remains a separate boundary. Import checks integrity, converts supported older archive shapes and reconnects image and PDF references to imported files. Unmatched references remain represented for review rather than acquiring an unrelated file by guesswork.

Follow [project services](../../../apps/backend/src/projects/) for revision writes, transactions and export state. [Asset lifecycle](../04-section-data/02-p-asset-management.md) owns file adoption and cleanup, and [deployment backups](../08-section-deployment/01-p-self-hosted.md#back-up-and-restore) covers installation recovery. Portable exports and operator backups have different scopes: one represents selected project data, while the other must recover the installation's durable services.
