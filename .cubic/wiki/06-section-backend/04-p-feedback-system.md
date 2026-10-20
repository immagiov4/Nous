---
title: "Feedback delivery and follow-up"
wiki_page_id: "p-feedback-system"
---

[Up one level](../05-section-frontend/03-p-admin-ui.md)

# Feedback delivery and follow-up

A submitted report is saved for administrators first. When GitHub publication is configured, the server then attempts to create a linked issue, keeping the local report available if delivery fails.

## Attached information

The form shows optional product diagnostics before submission. These contain a limited context and recent actions, excluding prompts, source text and credentials. The server redacts recognized credential patterns, email addresses and URL query information from report text and diagnostics.

Screenshots remain private to the installation; the GitHub issue records that an attachment exists.

## Retry and synchronize

Administrators can retry failed publication and synchronize the linked issue's open or closed state. Reports created directly in GitHub leave the local list only after two consecutive sync results omit them.

The [feedback route](../../../apps/backend/src/routes/feedback.ts) is the entry point for changes. [Admin controls](../05-section-frontend/03-p-admin-ui.md) owns the review interface.
