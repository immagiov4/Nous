---
title: "Feedback and GitHub"
wiki_page_id: "p-feedback-system"
---

# Feedback and GitHub

Learners can send a bug report or suggestion from Nous. The report is saved for administrators to review; when GitHub publication is configured, the server also attempts to create a linked issue.

## What a report contains

Before the learner submits, the form shows which optional product diagnostics will be attached. Diagnostics use a limited set of context and recent actions. Free-form prompts, source text and credentials are excluded.

Before saving or publishing report text and diagnostics, the server redacts recognized credential patterns, email addresses and URL query information. Screenshots remain private to the installation; the GitHub issue only notes that an attachment exists.

## Delivery and follow-up

The report is saved before GitHub publication. If GitHub is unavailable or rejects the request, administrators can review the report and retry publication later.

Administrators can sync issue status so the report reflects whether its linked issue is open or closed. A report created directly in GitHub is removed from the local list only after two consecutive sync results omit it.

See [Admin area](../05-section-frontend/03-p-admin-ui.md) for feedback review.
