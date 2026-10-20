---
title: "Project file lifecycle"
wiki_page_id: "p-asset-management"
---

[Up one level](01-p-database-schema.md)

# Project file lifecycle

A workflow prepares a file before a saved project adopts its reference. Cleanup can remove an abandoned file only after confirming that no project uses it.

## Sources and generated images

Uploaded sources belong to their project; identical uploads in different projects stay separate. Archives retain an index for selected-file retrieval. Generated images and extracted PDF images use stored bytes plus descriptive references in the lesson.

When a PDF source changes, its image context is refreshed so captions and placement do not silently describe the earlier file.

## Backups

A project backup carries its saved data and the files needed for restoration. Restore checks integrity and reconnects references to imported copies. Prepared playback audio is regenerated when needed and is excluded from project backups.

Library exports combine project archives; [Manage projects and backups](../03-section-features/05-p-project-workspace.md) owns the learner's export and retry path. Operator backups have a different scope: see [deployment backups](../08-section-deployment/01-p-self-hosted.md#back-up-and-restore).
