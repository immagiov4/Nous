---
title: "Administrative service boundary"
wiki_page_id: "p-admin-ui"
---

[Up one level](../02-section-architecture/01-p-architecture.md)

# Administrative service boundary

Administrative surfaces expose account management, feedback handling, model configuration and research inspection. Their authority comes from backend role checks on the authenticated account. Frontend navigation presents those capabilities, while the server decides whether a request may execute them.

## Configuration affects subsequent provider work

Model configuration supplies task-specific choices for context, planning, lesson writing and visuals. Provider capability checks still apply when a request executes; a stored model choice cannot make an unsupported image or structured-output request valid. The [provider boundary](../07-section-ai/01-p-ai-providers.md) owns translation and capability handling.

Account provider assignments can authorize use of the installation's [private Codex connection](../06-section-backend/03-p-codex-server.md). That is access to a shared host account through Nous, so authorization belongs to server-side policy rather than disclosure of provider credentials to the browser.

## Diagnostic tools expose stage evidence

The Research Lab exposes retrieval diagnostics from the [research pipeline](../03-section-features/06-p-youtube-research.md), helping developers inspect why a transcript was retrieved or admitted to model context. That diagnostic route is separate from the candidate classification recorded by lesson generation. The video-research page explains where each decision is retained.

Feedback management operates on saved local reports and their optional GitHub issue relationship. Failed delivery leaves the local record available; synchronization updates the recorded issue state. [Feedback delivery](../06-section-backend/04-p-feedback-system.md) owns redaction and publication semantics.

When extending an administrative operation, trace its route through [authentication](../06-section-backend/02-p-auth.md) to the owning service and persisted record. A role-aware component is only the presentation layer of that path. Tests should reach the protected HTTP boundary with permitted and unpermitted identities so a UI change cannot accidentally become the only enforcement.
