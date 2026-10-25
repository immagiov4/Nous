---
title: "Contextual chat and tools"
wiki_page_id: "p-chat-ui"
---

[Up one level](../05-section-frontend/01-p-reader-shell.md)

# Contextual chat and tools

A chat response can arrive after the reader has navigated to another lesson. If the response used the currently displayed page at that point, its explanation or proposed note could attach to the wrong material. Nous binds the conversation to its lesson, passage or note before requesting the response and carries that context through streaming and tool execution.

Playback questions also capture the passage, the rendered visual and its current emphasis, and the sentence being heard. The stage supplies this snapshot from its displayed state and voice clock, independently of the captions' intentional lead. Each new question captures the current stage and keeps that context through its response and artifact tools; revisions also carry the source draft and the user's requests. The tool can omit its repeated prompt and operation: the conversation supplies the request, and a source artifact reference selects a revision. Regenerating from an artifact card captures the stage for that operation. The conversation remains attached to the originating lesson as playback or navigation changes.

## Retrieve evidence within that conversation

The saved context supplies the question's meaning and the scope of retrieval. For archive-backed lessons, tools can search the retained index or open an indexed text file. Results keep the source and path, and the backend restricts access to the authorized project and source version attached to the lesson. [Archive access](../../../apps/backend/src/projects/sourceArchiveAccess.ts) owns that boundary.

Library chat starts with selected projects or folders instead of a single passage. Its wider context changes the available evidence, while the same principle holds: retrieved material supports the answer without silently changing the conversation's target.

## Apply an action to its original target

A proposed note needs a concrete text anchor. Validation checks that the suggested passage can be located before saving it; the model's proposed location alone is insufficient. Keeping the original lesson context through this check prevents a valid quote from being applied to whichever page is active when streaming finishes.

Some tools execute on the server, while a workspace action such as creating a note requires the browser to complete it. [OpenRouter and Codex](../07-section-ai/01-p-ai-providers.md) expose different streaming protocols, but both must preserve these application contracts. Model output requests an action; the owning application boundary validates and authorizes the change.

The [chat route](../06-section-backend/01-p-api-routes.md) locates request handling, and [reader composition](../05-section-frontend/01-p-reader-shell.md) locates selection and navigation state. A change spanning them needs to verify that the response remains attached to the same passage across navigation.
