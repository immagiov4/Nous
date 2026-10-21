---
title: "Durable data and ownership"
wiki_page_id: "p-database-schema"
---

[Up one level](../02-section-architecture/01-p-architecture.md)

# Durable data and ownership

Opening the library needs names, folders and project placement; opening a course needs its lessons and saved progress. Nous stores these separately so a library listing does not fetch every complete course. PostgreSQL holds both forms of records, while Supabase Storage holds the source and generated file bytes their references identify.

Course responses requested by the browser retain source segment identifiers, headings and page spans with deferred text. Context questions, assessment and exercise generation share the first text request for that loaded source; lesson workflows read the complete stored snapshot. An omitted or deferred index in a save retains the authoritative index in the same transaction. Complete exports and clients requesting the full response receive source text.

## Commit a project as one versioned unit

A project snapshot groups its course, lesson content and study progress under an owner and revision. Generation prepares intermediate results outside that snapshot, then makes them visible by committing a project mutation. This gives the reader one accepted version to load while other work continues in [durable workflows](../02-section-architecture/02-p-workflow-engine.md).

Several writers can work against the same snapshot, including a browser and lesson generation. Revision checks reject a stale replacement before it overwrites newer work. A separate incarnation identity distinguishes a recreated project from a deleted object with the same identifier. [Saving and exporting](../03-section-features/05-p-project-workspace.md) follows the consistency checks through concurrent changes.

## Keep file ownership alongside references

A committed snapshot can refer to a file whose bytes live outside PostgreSQL. Those resources need coordinated lifetimes: generation can write a file before the project adopts it, and cleanup must establish that no live project still references it before deletion. [Asset lifecycle](02-p-asset-management.md) explains this provisional ownership and adoption.

The same separation matters for recovery. Restoring database records alone cannot recreate uploaded source bytes that exist only in storage. The [deployment recovery contract](../08-section-deployment/01-p-self-hosted.md#back-up-and-restore) defines the installation backup scope.

## Find the authoritative record

| Question | Record owner |
| --- | --- |
| What course content and progress is accepted? | Project snapshot and revision. |
| Where does a project appear in the library? | Library folders and placement. |
| Which generation steps remain? | Workflow runs, steps, waits and saved provider effects. |
| Which defaults apply to new work? | Account preferences; a course keeps its copied settings. |

The [migrations](../../../supabase/migrations/) are the table and constraint reference. Backend connections are privileged, so [authorization](../06-section-backend/02-p-auth.md) must establish account and ownership before accessing these records. The separate [curriculum validators](03-p-curriculum-contract.md) check caller-supplied data rather than defining the production persistence path.
