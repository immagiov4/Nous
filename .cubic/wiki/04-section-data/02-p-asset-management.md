---
title: "Project Files and Storage"
wiki_page_id: "p-asset-management"
---

# Project Files and Storage

Project records and file contents are stored separately. PostgreSQL keeps project information and file references; Supabase Storage holds uploaded documents, archives and generated images.

## Uploaded sources

A learner can attach PDFs, text files and supported archives to a project. ZIP archives are indexed so the app can list their files and retrieve selected text without loading the whole archive into a lesson.

Uploaded source files belong to their project. Matching files in two projects are stored separately, which keeps ownership and deletion clear.

## Generated images

Workflows prepare generated images before a saved project refers to them. A successful save adopts the files it uses. Files left behind by a failed or abandoned workflow can be removed after the system confirms that no project refers to them.

PDF lesson images follow the same rule. The lesson stores references and descriptive information while the image bytes remain in storage. When a source PDF changes, the app refreshes its image context so a lesson does not silently rely on captions or placements from the earlier file.

## Project backups and library exports

A project backup contains its saved project data and the files needed to restore it. The restore process checks file integrity and reconnects references to the imported copies.

Full-library exports combine project archives. If a project changes during preparation, the current attempt fails; retrying starts a new export with a fresh library snapshot. Prepared playback audio is not part of a backup; the app can prepare it again when the learner listens.
