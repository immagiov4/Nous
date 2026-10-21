---
title: "Reader composition and state"
wiki_page_id: "p-reader-shell"
---

[Up one level](../02-section-architecture/01-p-architecture.md)

# Reader composition and state

The reader must keep a saved lesson usable while its replacement is still generating. It therefore represents committed project content and pending work alongside one another instead of clearing the lesson when generation starts. A successful commit replaces the content and resets dependent study state; failure leaves the saved lesson and progress intact.

## Separate content lifetime from interaction lifetime

Server project state supplies accepted lesson content and progress. The browser owns the current selection, open panels and playback controls, which can change without a project save. The [application composition](../../../apps/web/app/) joins these lifetimes: it passes the active target and its state into the content renderer, navigation and dialogs.

Navigation can change that target while other interactions are unfinished. A selected passage needs a stable mapping to saved lesson text so an annotation can retain its anchor. A streaming [chat response](../03-section-features/07-p-chat-ui.md) must retain the lesson where it began rather than adopt the page active when it arrives. These are identity requirements across interactions, not just rendering concerns.

## Present independent work without changing the target

The sidebar reflects the course structure and activity readiness. A practical exercise brief can finish while a different lesson is open; its activity view is separate from narrated lesson playback. Likewise, failure elsewhere in the course can be reported without redirecting the active reader.

Recovery depends on what failed. A source reference needing repair takes precedence when the content cannot resolve its files, while generation failures can remain attached to the work that produced them. [Lesson generation](../03-section-features/02-p-lesson-gen.md) defines when a replacement becomes accepted content.

## Render the prepared playback contract

The [player](../03-section-features/04-p-multimedia.md) consumes prepared audio, scene cues and highlighted spans for that lesson version. Seeking and speed are browser state; narration and cue generation belong to backend preparation. [Playback projection](../03-section-features/04-p-multimedia.md#project-authored-content-into-spoken-blocks) preserves imported visual references and original text anchors, while narration preparation classifies ambiguous fences before audio work. The reader can therefore render explanatory prose as wrapping content without rewriting the saved lesson. Verify rendering changes with navigation, pending work and reload as well as the final frame, using the isolated scenarios described in [testing](../09-section-tools/02-p-testing-quality.md).
