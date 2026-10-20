---
title: "Public presentation boundary"
wiki_page_id: "p-marketing-waitlist"
---

[Up one level](../02-section-architecture/01-p-architecture.md)

# Public presentation boundary

The public page is a prepared demonstration of planning, reading and questions, combined with waitlist and sign-in entry points. Its examples can run without generating a course or contacting an AI provider. This gives the presentation a bounded, reproducible content path separate from authenticated project workflows.

## Prepared examples drive the demonstration

The [marketing components](../../../apps/web/components/marketing/) own the presentation and its prepared content. Wide layouts coordinate the demonstration with scrolling; narrow layouts use stage controls. Both presentations illustrate the same product journey, so their differences belong to responsive composition rather than separate generation mechanisms.

Prepared content is useful here because visitors can see a complete interaction without a provider account, private source material or the latency of a live generation run. It also means that a successful demonstration establishes the presentation path, while authenticated workflow behavior needs its own integration evidence. Keep public fixtures and private course data separate when changing these examples.

## Submission and authentication cross into the backend

Waitlist submission sends an email address and receives a success or failure outcome. Sign-in enters the application's normal [authentication flow](../06-section-backend/02-p-auth.md). These are real service boundaries even though the demonstration beside them uses prepared content; their loading, failure and validation states need to reflect the actual request result.

After authentication, private library and project requests use the same account and ownership checks as other backend routes. The public presentation does not establish access to a project or an AI provider. [Administrative surfaces](03-p-admin-ui.md) describes the separate privileged boundary.

Changes to the public page should therefore be verified in two parts: responsive prepared demonstrations, and the actual request contracts for submission and sign-in. The [testing guide](../09-section-tools/02-p-testing-quality.md) supplies the browser verification approach.
