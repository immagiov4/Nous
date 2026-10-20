---
title: "HTTP and workflow boundaries"
wiki_page_id: "p-api-routes"
---

[Up one level](../02-section-architecture/01-p-architecture.md)

# HTTP and workflow boundaries

Backend routes translate HTTP input into authenticated service operations. Private routes require a verified account, and administrative routes additionally require its role. Request validation, authorization and domain execution are separate responsibilities: a valid body alone cannot establish ownership of the project it names.

| Route family | Responsibility |
| --- | --- |
| `/api/projects` | Project state, source files and library exports. |
| `/api/course-workflows` | Course generation requests and progress. |
| `/api/lesson-workflows` | Lesson generation requests and progress. |
| `/api/chat/context` | Model conversations with selected lesson context. |
| `/api/feedback` | Saved product reports. |
| `/api/admin` | Privileged account, model and report operations. |
| `/api/status` | Deployment and support status. |

## Short mutations and durable requests return different evidence

A project mutation checks the supplied revision before committing its change. A stale save returns a conflict, allowing the client to reconcile against authoritative state. Long generation work instead starts or reconnects to a durable run and exposes its progress separately from final project content. A successful start response establishes acceptance, while the saved workflow outcome establishes completion.

The backend returns a request identifier for correlation with diagnostics. A run retains that correlation through its lifecycle, including failures delivered through a successful progress response. User-facing errors use stable messages; technical details belong in server diagnostics. [Observability](05-p-telemetry-usage.md) explains what those records retain.

## Trace at the service owner

Use [route handlers](../../../apps/backend/src/routes/) for exact methods and payload validation rather than treating this family map as an exhaustive endpoint specification. From a handler, follow [authentication](02-p-auth.md), the project service and then the [workflow runtime](../02-section-architecture/02-p-workflow-engine.md) where applicable. File access additionally needs the [asset boundary](../04-section-data/02-p-asset-management.md).

This order matters for verification: route tests can establish authentication, input and response contracts with controlled stores, while PostgreSQL and provider integration tests establish the service behaviors those doubles replace. [Testing and quality](../09-section-tools/02-p-testing-quality.md) identifies both paths.
