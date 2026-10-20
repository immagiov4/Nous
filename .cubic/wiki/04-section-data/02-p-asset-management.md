---
title: "Asset adoption and cleanup"
wiki_page_id: "p-asset-management"
---

[Up one level](01-p-database-schema.md)

# Asset adoption and cleanup

A workflow can prepare a file before a saved project references it. Asset ownership represents that provisional state; adoption connects the file to a committed project reference. Cleanup can remove abandoned output only after establishing that no project still uses it. This separates interrupted preparation from intentional deletion.

## Identity includes the source context

Uploaded sources belong to their project, and identical uploads in separate projects remain separate resources. Code archives retain an index for selected-file retrieval. Extracted PDF images carry page and text context; generated visuals carry their stored bytes and lesson references. A content match alone cannot establish which project or source version authorizes retrieval.

Replacing a PDF source refreshes the image context used by generation so a caption or placement cannot silently describe the earlier document. The source artifact and source visual identities matter together when resolving a reference. The owning code lives under [project services](../../../apps/backend/src/projects/), with ingestion described in [source preparation](../03-section-features/03-p-doc-processing.md).

## Workflow output becomes durable content at adoption

Generation may fail after writing a file but before saving a lesson. Keeping a provisional owner makes that output distinguishable from a file already adopted by a project. Conversely, cleanup must consider live references so one failed attempt cannot remove content committed by another supported path. Workflow replay therefore needs both safe file operations and transactional reference changes.

Playback audio is derived from the saved lesson and its selected voice/model context. It follows preparation and persistence but is excluded from portable project archives; restored projects can prepare it again. Original sources and lesson visuals have different recovery requirements because their bytes are part of the retained course material.

## Portability and installation recovery differ

[Project export](../03-section-features/05-p-project-workspace.md) carries saved data and the files needed to restore that project. Import checks integrity and reconnects references to the imported copies. [Deployment backups](../08-section-deployment/01-p-self-hosted.md#back-up-and-restore) cover installation services and have their own documented storage scope. Choose the corresponding recovery contract when changing archive contents or storage cleanup; a valid project archive does not establish that every installation asset is recoverable.
