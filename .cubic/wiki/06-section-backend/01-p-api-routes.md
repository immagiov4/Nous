---
title: "API route reference"
wiki_page_id: "p-api-routes"
---

[Up one level](../02-section-architecture/01-p-architecture.md)

# API route reference

Find the matching handler in [backend routes](../../../apps/backend/src/routes/). Private requests require a verified account; administrator requests also require its role. [Authentication](02-p-auth.md) owns those checks.

| Route | Responsibility |
| --- | --- |
| `/api/projects` | Projects, source files and library exports. |
| `/api/course-workflows` | Course generation and its progress. |
| `/api/lesson-workflows` | Lesson generation and its progress. |
| `/api/chat/context` | Questions about selected lesson, text or note context. |
| `/api/feedback` | Learner reports. |
| `/api/admin` | Accounts, model settings and administrative reports. |
| `/api/status` | Deployment and support status. |

## Trace a response

The backend returns a request ID to correlate the response with diagnostics. User-facing errors carry stable messages while technical details stay in server logs.

Project updates supply a revision for stale-save detection. Long generation requests expose progress separately from the finished content through the [workflow engine](../02-section-architecture/02-p-workflow-engine.md). [File storage](../04-section-data/02-p-asset-management.md) and [provider configuration](../07-section-ai/01-p-ai-providers.md) own those request paths' supporting contracts.
