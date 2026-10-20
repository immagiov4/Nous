---
title: "Reader composition and state"
wiki_page_id: "p-reader-shell"
---

[Up one level](../02-section-architecture/01-p-architecture.md)

# Reader composition and state

The reader composes the active project and lesson with navigation, content rendering and study interactions. Saved content comes from server project state; selection, open panels and playback controls are browser interaction state. Keeping those lifetimes distinct lets a project update without turning every transient interaction into a persistence operation.

## Compose around the active target

The [application composition](../../../apps/web/app/) connects the reader's props and dialogs to application state. The main content renderer presents lesson text, source references, visuals and quizzes, while the sidebar reflects course structure and activity readiness. Exercise briefs can generate independently of the lesson currently displayed, and practical exercises have an activity view rather than narrated lesson playback.

Selections need a stable mapping between rendered text and saved lesson content. Annotation anchors and chat context use that mapping; they must remain attached to their original lesson when navigation changes the active target. [Contextual chat](../03-section-features/07-p-chat-ui.md) explains why a streaming response cannot simply use the current page when it arrives.

## Generation status and saved content coexist

The saved lesson remains readable during regeneration. A successful replacement updates committed content and resets content-dependent study state; failure preserves the earlier saved version. The frontend therefore represents pending work alongside saved data rather than clearing the lesson at request start. [Lesson generation](../03-section-features/02-p-lesson-gen.md) owns the commit semantics.

Load failures, source reconnection requirements and generation failures have different recovery paths. A source problem takes precedence when the content needs its file references repaired. Failures on the active lesson can be shown in context, while work failing elsewhere can be reported without changing the current target.

## Playback consumes a prepared contract

The [player](../03-section-features/04-p-multimedia.md) coordinates audio, visual scenes and highlighted spans against prepared lesson blocks. Browser controls own seeking and speed; backend preparation owns narration and cue generation. For rendering changes, verify realistic lesson fixtures, navigation and intermediate states as well as the final screenshot. [Testing](../09-section-tools/02-p-testing-quality.md) describes the isolated browser and artifact evidence paths.
