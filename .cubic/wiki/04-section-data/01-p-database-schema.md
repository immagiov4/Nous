---
title: "Database and Saved Data"
wiki_page_id: "p-database-schema"
---

# Database and Saved Data

PostgreSQL stores account data, project details, learning plans, learner progress, workflow state and feedback. Supabase Storage holds uploaded source files and other binary content; database records point to those files.

## Projects and the library

A project has an owner, a current revision and a saved snapshot. The snapshot contains the course, lessons and progress. A separate project record keeps the information needed to display and organize the library without loading the full course.

The library stores folder structure and the position of each project. Projects and source files remain scoped to their owner.

## Workflows and account settings

Long-running course and lesson tasks have saved workflow records, so the app can show progress and recover work after a restart. Workflow event records help explain what happened without storing prompts, source content or provider payloads.

Account preferences hold language and teaching instructions for new work. Changing those preferences does not rewrite courses that have already been saved.

## Feedback and usage

Feedback reports are saved for administrators and can be linked to GitHub issues. Model usage records track reported tokens and costs when the provider supplies them; those records may not include every operation or form a complete invoice.

## Consistency and access

Project revisions help detect when two sessions try to save conflicting changes. Library exports record which project versions they contain so a changed project is not mistaken for the earlier export snapshot.

Authenticated database clients are subject to database access policies. Backend requests also rely on server-side authentication and ownership checks. See [Authentication and access](../06-section-backend/02-p-auth.md) for how those boundaries work.

For source files, generated images and backups, see [Project files and storage](02-p-asset-management.md).
