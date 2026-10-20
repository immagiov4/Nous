---
title: "Administrative service boundary"
wiki_page_id: "p-admin-ui"
---

[Up one level](../02-section-architecture/01-p-architecture.md)

# Administrative service boundary

An administrator can change provider access for another account or inspect reports and research diagnostics. These operations reach beyond an ordinary user's projects, so the backend checks the authenticated account's role before executing them. Administrative navigation exposes the permitted operations, while the server retains their authority.

## Follow each operation to its service

| Capability | Owning behavior |
| --- | --- |
| Account and provider assignments | Authorize use of installation resources, including the shared private Codex account. |
| Task-specific model configuration | Select models for context, planning, writing and visuals; execution still checks capabilities. |
| Research Lab | Inspect discovery, transcript retrieval and admission to model context. |
| Feedback management | Read retained reports and manage their linked GitHub issue state. |

Provider assignments deserve particular care because the [Codex adapter](../06-section-backend/03-p-codex-server.md) uses a shared host account. The browser receives permission through Nous rather than the host's credentials. Similarly, saving a model choice does not make an unsupported image or structured-output request executable; the [provider boundary](../07-section-ai/01-p-ai-providers.md) checks the requested capability when work runs.

## Interpret diagnostic results at their stage

The Research Lab can explain why a transcript was unavailable or excluded from context. The later model classification of a candidate belongs to the lesson research dossier, so retrieval success alone cannot explain why a video was selected. [Video research](../03-section-features/06-p-youtube-research.md) follows those decisions in order.

Feedback management likewise operates on a saved local report and a separate publication relationship. Failed delivery leaves the report available; synchronization updates its issue state. [Feedback publication](../06-section-backend/04-p-feedback-system.md) owns that lifecycle and its privacy boundary.

When adding an operation, follow its [authenticated route](../06-section-backend/02-p-auth.md) to the owning service and test the protected request with permitted and unpermitted identities. That reaches the authority boundary the administrative component presents.
