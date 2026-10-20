---
title: "Manage projects and backups"
wiki_page_id: "p-project-workspace"
---

[Up one level](../05-section-frontend/01-p-reader-shell.md)

# Manage projects and backups

The library keeps courses and their study progress in projects. Use folders to group them and export a backup when you need a portable copy.

## Organize the library

Create, rename or move folders, then move projects into them. Deleting a folder moves its contents to the parent folder and keeps its projects.

Project changes save as you work. If another session has changed the same project, a revision conflict asks the client to reload or reconcile it rather than overwrite that version.

## Export and restore

Export one project or the whole library. A library export prepares projects in sequence and records progress across a server restart. If a project changes during preparation, the attempt fails; retrying begins a fresh library snapshot.

The browser can start the verified download. Check the downloaded file on your device when keeping a backup. Imports convert supported older archives and reconnect image and PDF references when their files are present; unmatched references remain available for review.

For the contents of a backup and file lifecycle, see [project files and storage](../04-section-data/02-p-asset-management.md). For answer and annotation changes during regeneration, see [exercise progress](08-p-interactive-exercises.md).
