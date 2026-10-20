---
title: "Find your way through the code"
wiki_page_id: "p-architecture"
---

[Up one level](../index.md)

# Find your way through the code

The browser presents the library and reader. Requests go to the backend, which saves projects, prepares sources and runs generation. Shared contracts define what both sides exchange.

## Choose the owner

| Area | Start here when changing… |
| --- | --- |
| [apps/web](../../../apps/web/) | Reading, playback, chat and other browser interactions. |
| [apps/backend](../../../apps/backend/) | Requests, authentication, persistence and generation. |
| [packages/shared-types](../../../packages/shared-types/) | Data shapes shared by browser and server. |
| [packages/playtest](../../../packages/playtest/) | Reusable browser-test tools. |
| [e2e/nous](../../../e2e/nous/) | Nous-specific product scenarios. |

The root package coordinates development and checks; `apps/backend` is the declared Bun workspace. Use [local setup](../09-section-tools/01-p-local-setup.md) for a running instance and [testing](../09-section-tools/02-p-testing-quality.md) for a change's verification path.

## Follow a request

The [API reference](../06-section-backend/01-p-api-routes.md) locates request handlers; [authentication](../06-section-backend/02-p-auth.md) explains access checks. Long tasks enter the [workflow engine](02-p-workflow-engine.md). [Course](../03-section-features/01-p-course-gen.md) and [lesson generation](../03-section-features/02-p-lesson-gen.md) explain its learning-specific work.

[Saved data](../04-section-data/01-p-database-schema.md) owns persistence structure, with [file storage](../04-section-data/02-p-asset-management.md) and [curriculum validation](../04-section-data/03-p-curriculum-contract.md) below it.

## Follow an integration

[AI providers](../07-section-ai/01-p-ai-providers.md) covers model configuration and links to the Codex connection. [Workflow events and usage](../06-section-backend/05-p-telemetry-usage.md) explains operational records. [Feedback delivery](../06-section-backend/04-p-feedback-system.md), the [admin area](../05-section-frontend/03-p-admin-ui.md) and the [public page](../05-section-frontend/02-p-marketing-waitlist.md) describe their own flows.

For operation, choose [self-hosted](../08-section-deployment/01-p-self-hosted.md) or [managed data services](../08-section-deployment/02-p-managed-deploy.md).
