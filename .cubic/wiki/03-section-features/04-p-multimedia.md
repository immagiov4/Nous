---
title: "Narration and synchronized playback"
wiki_page_id: "p-multimedia"
---

[Up one level](../05-section-frontend/01-p-reader-shell.md)

# Narration and synchronized playback

Narration and a rendered lesson do not use identical text. A formula is displayed as symbols but spoken as words; the player needs a connection between those representations to highlight what the voice is explaining. Nous prepares each saved lesson block with audio, visual references and timing cues, then lets the browser play that prepared result.

## Project authored content into spoken blocks

Imported content can embed stored visual references in prose, annotation wrappers, tables or formula cards. The shared projection attaches the referenced visual to its spoken passage and includes that visual content in playback identity, while leaving the authored source and text offsets intact. Reference syntax inside authored code stays literal. Explicit Mermaid code blocks become diagram visuals; generated lesson prose uses the scene pipeline.

A text-labelled or unlabelled fence can contain either an explanation or code. Structured narration preparation classifies every eligible occurrence before audio work, so explanatory prose receives narration and a wrapping card while logs, diagrams and code retain fenced visuals. Exact occurrence coverage is validated, and saved decisions are reused across voices; audio lacking a required decision needs preparation again. The [shared projection](../../../packages/shared-types/lessonPlayback.ts) and [narration preparation](../../../apps/backend/src/services/lessonPlayback/playbackSpokenMath.ts) own that distinction. Lesson writing and code-structure review require mathematical explanations outside code fences and reject incomplete classifications or remaining prose for correction.

## Prepare the explanation being spoken

The [block preparation service](../../../apps/backend/src/services/lessonPlayback/prepareLessonPlaybackBlock.ts) validates speech and scene compatibility and prepares spoken mathematics where needed. Formula spans connect the resulting speech to the symbols displayed in the lesson, as shown in the README illustration.

Visual preparation uses the block's existing scene references or requests a scene grounded in that block's speech. Using general lesson metadata here could illustrate a different passage. Motion cues connect explanation points to scene elements; when several scenes would make a motion target ambiguous, the scenes remain visible without that target.

Audio and visual preparation run concurrently. Both operations settle before a failure propagates, so an attempted retry does not overlap unfinished paid work from that attempt. The [playback workflow](../../../apps/backend/src/workflows/lessonPlaybackWorkflow.ts) keeps this provider preparation separate from persistence.

## Adopt results only for the matching content

Preparation identifies the project incarnation, section, lesson content key, block, voice and speech model. These identities let persistence attach the audio and cues to the content that requested them. Otherwise, a changed lesson could receive a valid audio file that narrates its earlier version. [Asset adoption](../04-section-data/02-p-asset-management.md) owns the stored file references.

Speech synthesis uses the backend's [OpenRouter speech client](../../../apps/backend/src/services/ttsClient.ts), which resolves model-specific voices and normalizes supported responses. A Codex text connection therefore still needs OpenRouter for narration.

With those results ready, the [reader](../05-section-frontend/01-p-reader-shell.md) owns seeking, speed and presentation. Reduced-motion preferences retain the visual while suppressing motion, leaving the explanation available under a different presentation preference.

Playback causal scenes use an ordered grid with numbered cards: two columns on desktop and one at the existing narrow scene-host query. Connectors use unscaled card positions to follow authored order across the row gap. The stage retains its caption and visual columns and fits the complete scene into the available area. The [causal grid](../../../apps/web/components/shared/lessonScene/CausalGrid.tsx) owns these cards and connectors.
