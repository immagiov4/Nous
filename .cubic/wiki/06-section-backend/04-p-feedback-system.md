---
title: "Feedback persistence and publication"
wiki_page_id: "p-feedback-system"
---

[Up one level](../05-section-frontend/03-p-admin-ui.md)

# Feedback persistence and publication

A failed GitHub request must not lose the report a user just submitted. Nous saves feedback in the installation before attempting optional issue creation, keeping the report available for administrative review or another delivery attempt. The GitHub issue is a linked public copy with its own delivery and synchronization state.

## Prepare a public copy of a private report

A report about a course can contain context intended only for the installation. The form therefore shows optional, bounded product diagnostics before submission; these exclude prompts, source text and credentials. Before publication, the server additionally redacts recognized credential patterns, email addresses and URL query information from report text and diagnostics.

Screenshots remain private. The public issue records that an attachment exists rather than publishing its image. This lets a maintainer know the local report has supporting material without publishing the screenshot. Follow fields through the [feedback route](../../../apps/backend/src/routes/feedback.ts) when changing what the public copy contains.

## Track delivery independently of the report

Once local persistence succeeds, configured publication attempts issue creation. A failed attempt can be retried against the retained report rather than requiring the user to submit it again. After an issue is linked, synchronization updates its open or closed state independently of the original delivery outcome.

Synchronization also tracks reports originating directly in GitHub in the local list. Those reports leave the list after two consecutive synchronization results omit them. This prevents one omitted synchronization result from immediately removing the imported report. Tests of this lifecycle need to distinguish saved reports, delivery outcomes and synchronized issue state.

[Administrative services](../05-section-frontend/03-p-admin-ui.md) provide the management surface, with role enforcement described in [authentication](02-p-auth.md).
