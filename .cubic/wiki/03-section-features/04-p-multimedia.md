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

The [speech preparation module](../../../apps/backend/src/services/speechPreparation.ts) owns narration for the standard reader and synchronized playback. Both consumers submit the same source-mapped blocks, including inline and display mathematics. A model supplies pronunciation with the shared narration instructions, and exact ordered occurrence validation precedes synthesis. Captions and annotation anchors resolve those same saved pronunciations.

Paid narration is stored in an owner-scoped PostgreSQL cache keyed by source, the preparation contract and the configured preparation model/provider. A transaction lock deduplicates concurrent requests for that identity across HTTP handlers and workflow workers. Workflow provider-effect checkpoints record cache hits as well as newly generated narration, retaining one pronunciation across retries. Saved prepared blocks and recordings remain authoritative for their existing narration; requesting another voice reuses their pronunciation. The speech client receives the same whitespace normalization, voice/model resolution and speed shape from both readers.

The standard reader retains source notation until backend preparation. Its rendered DOM supplies selection geometry, while the source-mapped blocks determine speech. Audio chunks follow those blocks, so formulas and ambiguous fences stay intact through preparation. Oversized prepared narration is synthesized in bounded requests and joined in the shared mono MP3 format. The renderer projection supplies text-selection labels, including decoded prose entities and literal inline-code content.

The [block preparation service](../../../apps/backend/src/services/lessonPlayback/prepareLessonPlaybackBlock.ts) validates speech and scene compatibility and prepares spoken mathematics where needed. Formula spans connect the resulting speech to the symbols displayed in the lesson, as shown in the README illustration.

Visual preparation uses the block's existing scene references or requests a scene grounded in that block's speech. Using general lesson metadata here could illustrate a different passage. Motion cues connect explanation points to scene elements; when several scenes would make a motion target ambiguous, the scenes remain visible without that target.

Audio and visual preparation run concurrently. Both operations settle before a failure propagates, so an attempted retry does not overlap unfinished paid work from that attempt. The [playback workflow](../../../apps/backend/src/workflows/lessonPlaybackWorkflow.ts) keeps this provider preparation separate from persistence.

## Adopt results only for the matching content

Preparation identifies the project incarnation, section, lesson content key, block, voice and speech model. These identities let persistence attach the audio and cues to the content that requested them. Otherwise, a changed lesson could receive a valid audio file that narrates its earlier version. [Asset adoption](../04-section-data/02-p-asset-management.md) owns the stored file references.

Speech synthesis uses the backend's [OpenRouter speech client](../../../apps/backend/src/services/ttsClient.ts), which resolves model-specific voices and normalizes supported responses. A Codex text connection therefore still needs OpenRouter for narration.

With those results ready, the [reader](../05-section-frontend/01-p-reader-shell.md) owns seeking, speed and presentation. Reduced-motion preferences retain the visual while suppressing motion, leaving the explanation available under a different presentation preference.
