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

## Follow a formula through its explanation

A block without visuals, or with mathematical Markdown cards only, lets the model choose a scene or presentation of the complete text. Preparation supplies the authored passage for mathematical facts and quantities, and canonical narration for spoken anchors. Blocks with imported diagrams preserve those authored visuals; existing prepared scenes keep their saved choice under the content cache contract.

When the model chooses formula spotlight, the formula and symbol names remain visible while the currently spoken symbol expands its meaning. The [scene contract](../../../packages/shared-types/formulaSpotlight.ts) requires a formula with explicit symbol references and an ordered legend with exact, unique narration anchors. Validation checks rendered KaTeX targets, including macro expansions, and rejects authored HTML and URL commands. Formula validation, display and legend notation share a maximum explicit KaTeX dimension of 2 em; macro expansion uses the library default. Mathematical faithfulness remains part of scene generation and its provider verification.

The [stage](../../../apps/web/components/workspace/playback/LessonPlaybackStage.tsx) maps those anchors onto the measured caption clock, so normal playback and forward or backward seeking update the formula and legend together. Spoken pronunciations, captions, motion and audio use the same canonical narration while source spans retain their original Markdown ranges. [Formula rendering](../../../apps/web/components/shared/lessonScene/FormulaSpotlight.tsx) uses the scene's explicit symbol bindings; resize measurements are coalesced into animation frames and cancelled on unmount.

## Adopt results only for the matching content

Preparation identifies the project incarnation, section, lesson content key, block, voice and speech model. These identities let persistence attach the audio and cues to the content that requested them. Otherwise, a changed lesson could receive a valid audio file that narrates its earlier version. [Asset adoption](../04-section-data/02-p-asset-management.md) owns the stored file references.

Speech synthesis uses the backend's [OpenRouter speech client](../../../apps/backend/src/services/ttsClient.ts), which resolves model-specific voices and normalizes supported responses. A Codex text connection therefore still needs OpenRouter for narration.

With those results ready, the [reader](../05-section-frontend/01-p-reader-shell.md) owns seeking, speed and presentation. Reduced-motion preferences retain the visual while suppressing motion, leaving the explanation available under a different presentation preference.
