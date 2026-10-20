---
title: "Where saved data lives"
wiki_page_id: "p-database-schema"
---

[Up one level](../02-section-architecture/01-p-architecture.md)

# Where saved data lives

PostgreSQL keeps accounts, projects, progress and workflow records. Supabase Storage keeps uploaded files and generated images; database records refer to their bytes.

## Projects and library

A project record has an owner, revision and snapshot containing its course, lessons and progress. Library records hold folder structure and project placement so the app can display the library without loading each full course.

Project revisions detect stale saves. Export records identify the project versions being prepared, allowing an export to reject a changed snapshot. [File storage](02-p-asset-management.md) owns adoption and cleanup of files; [curriculum validation](03-p-curriculum-contract.md) owns learning-plan identities.

## Other records

Account preferences guide new work. Workflows persist runs, steps and diagnostic events; [the workflow engine](../02-section-architecture/02-p-workflow-engine.md) explains recovery. Feedback links administrator reports to GitHub issues, while [usage records](../06-section-backend/05-p-telemetry-usage.md) retain available provider measurements.

Use the [database migrations](../../../supabase/migrations/) for table definitions. [Authentication and access](../06-section-backend/02-p-auth.md) explains which layer enforces ownership.
