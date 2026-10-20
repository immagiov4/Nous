---
title: "Chat and Learning Context"
wiki_page_id: "p-chat-ui"
---

# Chat and Learning Context

Nous chat answers questions about a learner’s course, lesson or selected text. The learner can also ask about saved material, search the web, create a visual or propose a note, depending on the chat mode.

## Choosing a context

Library chat can include selected projects or folders. A reader conversation can focus on selected text, the current lesson or an existing note. The learner’s chosen context determines what information the assistant receives.

During course setup, chat also collects the learner’s course preferences and prior-knowledge responses. Those responses remain visible while the learner answers and submits a question set. The [course-generation page](01-p-course-gen.md) explains how that evidence informs the plan.

## Following up in a lesson

A lesson conversation stays tied to the lesson where it began, even when the learner opens another lesson. Retrieved material is added after the answer is complete and stays collapsed until the learner opens it.

The assistant can retrieve saved lesson details, search for source material, create a temporary visual, or suggest a note. A suggested note must match text that the reader can anchor in the lesson before the learner can save it.

## Questions about source archives

For archive-backed lessons, the assistant can search the retained source index or open a specific indexed text file. Results include the source name and path so the learner can check where an answer came from. Access is limited to the signed-in user’s project and the source version attached to that lesson.

## Model requests

Requests that use the OpenRouter-compatible proxy follow the configured model selection for their task. Other chat paths can connect directly to the configured provider service. The [AI provider page](../07-section-ai/01-p-ai-providers.md) describes the supported account and model options.
