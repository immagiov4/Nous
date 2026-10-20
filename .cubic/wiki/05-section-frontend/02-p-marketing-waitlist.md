---
title: "Public presentation boundary"
wiki_page_id: "p-marketing-waitlist"
---

[Up one level](../02-section-architecture/01-p-architecture.md)

# Public presentation boundary

The public page is a prepared demonstration of planning, reading and questions, combined with waitlist and sign-in entry points. Its examples can run without generating a course or contacting an AI provider. This gives the presentation a bounded, reproducible content path separate from authenticated project workflows.

## Prepared examples drive the demonstration

The [marketing components](../../../apps/web/components/marketing/) own the presentation and its prepared content. Wide layouts coordinate the demonstration with scrolling; narrow layouts use stage controls. Both presentations illustrate the same product journey, so their differences belong to responsive composition rather than separate generation mechanisms.

Visitors can therefore see a complete interaction without a provider account, private source material or the latency of live generation.

## Submission and authentication cross into the backend

Waitlist submission sends an email address and receives a success or failure outcome. Sign-in enters the application's normal [authentication flow](../06-section-backend/02-p-auth.md). These are real service boundaries even though the demonstration beside them uses prepared content; their loading, failure and validation states need to reflect the actual request result.

Changes to the public page should therefore be verified in two parts: responsive prepared demonstrations, and the actual request contracts for submission and sign-in. The [testing guide](../09-section-tools/02-p-testing-quality.md) supplies the browser verification approach.
