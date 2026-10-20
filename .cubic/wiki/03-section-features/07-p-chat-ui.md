---
title: "Contextual chat and tools"
wiki_page_id: "p-chat-ui"
---

[Up one level](../05-section-frontend/01-p-reader-shell.md)

# Contextual chat and tools

Contextual chat binds a conversation to a lesson, selected passage or note before requesting a model response. That binding supplies the meaning of the question and the scope of tool access. Library chat instead uses the selected projects or folders, so its context boundary is broader than a single reader passage.

## Preserve context across navigation

A conversation stays attached to the lesson where it began even if the browser navigates elsewhere. The request must therefore use its saved context rather than whichever lesson happens to be active when a response arrives. This separation also matters for streamed tool results: a note or explanation belongs to the original target.

Suggested notes must match text that the reader can anchor. Validation connects the proposed note to a concrete passage before it is saved; a model's proposed location is insufficient on its own. Retrieved material is presented with the answer as supporting evidence rather than replacing the conversation's target context.

## Tools cross explicit boundaries

For archive-backed lessons, the assistant can search the retained index or open an indexed text file. Results identify the source and path, and access remains within the authorized project and source version attached to the lesson. The backend's [archive access boundary](../../../apps/backend/src/projects/sourceArchiveAccess.ts) is the place to inspect when changing retrieval permissions.

Some learning actions execute on the server; others require the browser workspace to complete a change such as creating a note. Both [OpenRouter and Codex](../07-section-ai/01-p-ai-providers.md) must preserve the application tool contract despite their different streaming protocols. Provider output requests an action; application authorization and validation decide whether that action can be applied.

The [chat context route](../06-section-backend/01-p-api-routes.md) locates the HTTP entry point. Changes to selection projection, annotation anchors or navigation need [reader](../05-section-frontend/01-p-reader-shell.md) verification as well as request tests, because a structurally valid response can still be attached to the wrong passage.
