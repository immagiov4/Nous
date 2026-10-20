---
title: "Feedback persistence and publication"
wiki_page_id: "p-feedback-system"
---

[Up one level](../05-section-frontend/03-p-admin-ui.md)

# Feedback persistence and publication

Feedback is saved locally before optional GitHub publication. The local record therefore survives a delivery failure and remains available to the administrative surface. The GitHub issue is a linked publication target with its own state, rather than the sole copy of the report.

## Publication crosses a privacy boundary

The form presents optional product diagnostics before submission. These contain bounded context and recent actions while excluding prompts, source text and credentials. Before publication, the server redacts recognized credential patterns, email addresses and URL query information from report text and diagnostics. Screenshots remain private to the installation; the issue records attachment presence instead of publishing the image.

This boundary matters because a report about a course can contain context that should remain local. A successful redaction pass establishes the implemented transformations, not an authorization to attach arbitrary source files. Trace publication fields from the submitted form through the [feedback route](../../../apps/backend/src/routes/feedback.ts) and owning service when changing the report schema.

## Delivery and synchronization are separate state changes

When publication is configured, the server attempts issue creation after local persistence. Failed publication can be retried from the retained record. Synchronization then updates the linked issue's open or closed state independently of whether the original delivery was successful.

Reports originating directly in GitHub leave the local list only after two consecutive synchronization results omit them. That rule belongs to synchronization, while local submission and issue creation have their own outcomes. Tests should distinguish these states rather than treating any GitHub response as proof that a report has completed its full lifecycle.

[Administrative services](../05-section-frontend/03-p-admin-ui.md) owns access to management operations; [authentication](02-p-auth.md) explains the role checks. [Observability](05-p-telemetry-usage.md) describes the similarly bounded diagnostics used for workflow failures.
