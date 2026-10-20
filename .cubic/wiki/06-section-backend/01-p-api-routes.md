---
title: "Backend API"
wiki_page_id: "p-api-routes"
---

# Backend API

The backend API connects the web app to saved project data, generation workflows and AI providers. Private requests require a signed-in account; administrator routes also check the administrator role. Health and status information is available for deployment checks.

## Request identity

Each request has a request ID. The backend returns it in the response so support logs can be matched to the request. Error responses give the user a stable message while technical details stay in server diagnostics.

## Main route groups

| Route | Purpose |
| --- | --- |
| `/api/projects` | List, save, update and delete projects; manage source files and library exports. |
| `/api/course-workflows` | Start and follow course generation. |
| `/api/lesson-workflows` | Start and follow lesson generation. |
| `/api/chat/context` | Ask questions using selected lesson, text or note context. |
| `/api/feedback` | Submit a learner report for administrator review. |
| `/api/admin` | Manage accounts, model settings and administrative reports. |
| `/api/status` | Check service status for deployment and support. |

Project updates include a revision so the backend can reject a save based on stale data. Longer generation tasks return progress separately from the final course or lesson. See [Workflow engine](../02-section-architecture/02-p-workflow-engine.md).

## Files and AI requests

The API accepts supported source files and keeps their bytes in storage. Project records contain references to those files; see [Project files and storage](../04-section-data/02-p-asset-management.md).

Requests that need a provider use the configured server-side integration. Provider credentials are not sent to the browser. See [AI providers](../07-section-ai/01-p-ai-providers.md) for model selection and supported tools.
