---
title: "System Architecture"
wiki_page_id: "p-architecture"
---

# System Architecture

Nous Reader has a web app, a backend and shared contracts. The web app presents the library and learning tools; the backend handles saved data, source processing and long-running course or lesson generation.

## Code and package boundaries

| Area | Responsibility |
| --- | --- |
| [apps/web](../../../apps/web/) | The browser app and its learning tools. |
| [apps/backend](../../../apps/backend/) | The server, API and long-running work. |
| [packages/shared-types](../../../packages/shared-types/) | Data contracts shared across the app and backend. |
| [packages/playtest](../../../packages/playtest/) | Reusable tools for product-flow tests. |
| [e2e/nous](../../../e2e/nous/) | Nous-specific end-to-end test setup and scenarios. |

The root `package.json` manages the browser app and shared packages; `apps/backend` is the only declared Bun workspace. Root scripts coordinate development, checks and test runs.

## Where information lives

PostgreSQL stores project details, learning plans, lessons and learner progress. Uploaded documents and generated images live in file storage, with project records keeping references to those files.

A saved project keeps its course and progress together. Its sources remain separate files so large documents do not need to be copied into every saved project update.

## From project to course

When a learner adds source material, the backend stores the files and prepares searchable text or an archive index. Course generation uses that material to plan lessons and identify useful sources.

The workflow engine saves the progress of longer tasks. It lets the app report the current state and recover work after a restart. See [Workflow engine](02-p-workflow-engine.md) for details.

## Shared contracts

The web app and backend use shared definitions for project data, lessons and generation rules. These contracts help both sides interpret a saved course in the same way.

The [database page](../04-section-data/01-p-database-schema.md) explains stored data. [Project files and storage](../04-section-data/02-p-asset-management.md) describes source files and backups.
