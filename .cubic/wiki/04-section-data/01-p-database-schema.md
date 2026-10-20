---
title: "Durable data and ownership"
wiki_page_id: "p-database-schema"
---

[Up one level](../02-section-architecture/01-p-architecture.md)

# Durable data and ownership

PostgreSQL holds accounts, project snapshots, library structure and workflow state. Supabase Storage holds uploaded sources and generated file bytes, with database references connecting them to owners. The runtime uses server persistence; in-memory project stores are test doubles for exercising route behavior.

## A project is a versioned aggregate

A project record has an owner, revision and snapshot containing its course, lessons and study progress. Library records hold folder structure and placement separately, so listing the library does not require reading every full project. Revision checks detect stale saves, while project incarnation identity distinguishes a recreated project from an earlier object with a reused identifier.

This aggregate gives generation a concrete commit target. A workflow can prepare intermediate output, but it becomes visible project content when the corresponding project mutation commits. [Workflow execution](../02-section-architecture/02-p-workflow-engine.md) coordinates saved step state, and [project revisions](../03-section-features/05-p-project-workspace.md) explains concurrent saves and exports.

## File references have a lifecycle

A database reference and the bytes it names are separate resources. Provisional workflow output needs ownership before a project adopts it, and cleanup must check references before deleting an abandoned object. [Asset lifecycle](02-p-asset-management.md) owns that mechanism. A database-only recovery cannot restore source bytes that exist solely in storage.

## Other records support independent concerns

Account preferences provide defaults for new work; a course retains its own copied settings. Workflow runs, steps, waits and provider effects support execution recovery. Events and [usage measurements](../06-section-backend/05-p-telemetry-usage.md) support investigation without replacing those authoritative records. Feedback records retain local reports and their GitHub delivery relationship.

The [migrations](../../../supabase/migrations/) are the table and constraint reference. Backend access uses privileged connections, so [account and ownership checks](../06-section-backend/02-p-auth.md) must precede service access. Row-level security applies to authenticated clients that reach Supabase directly. [Curriculum validators](03-p-curriculum-contract.md) describe a separate supplied-data contract; their existence does not imply that production planning writes a curriculum graph through them.
