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

Paid narration is stored in an owner-scoped PostgreSQL cache keyed by source, the preparation contract and the configured preparation model/provider. Concurrent requests in one process serialize preparation while retaining each consumer’s cancellation signal. Database queries complete before the provider call. Independent workers use conflict-safe insertion and return the stored winner, retaining identical narration even when concurrent cold requests both generate a result. Workflow provider-effect checkpoints record cache hits as well as newly generated narration, retaining one pronunciation across retries. Saved prepared blocks and recordings remain authoritative for their existing narration; requesting another voice reuses their pronunciation. The speech client receives the same whitespace normalization, voice/model resolution and speed shape from both readers.

The standard reader retains source notation until backend preparation. Its rendered DOM supplies selection geometry, while the source-mapped blocks determine speech. Audio chunks follow those blocks, so formulas and ambiguous fences stay intact through preparation. Oversized prepared narration is synthesized in bounded requests and joined in the shared mono MP3 format. The renderer projection supplies text-selection labels, including decoded prose entities and literal inline-code content.

The [block preparation service](../../../apps/backend/src/services/lessonPlayback/prepareLessonPlaybackBlock.ts) validates speech and scene compatibility and prepares spoken mathematics where needed. Formula spans connect the resulting speech to the symbols displayed in the lesson, as shown in the README illustration.

Visual preparation uses the block's existing scene references or requests a scene grounded in that block's speech. Using general lesson metadata here could illustrate a different passage. Motion cues connect explanation points to scene elements; when several scenes would make a motion target ambiguous, the scenes remain visible without that target.

Audio and visual preparation run concurrently. Both operations settle before a failure propagates, so an attempted retry does not overlap unfinished paid work from that attempt. The [playback workflow](../../../apps/backend/src/workflows/lessonPlaybackWorkflow.ts) keeps this provider preparation separate from persistence.

## Follow a formula through its explanation

A block without visuals, or with mathematical Markdown cards only, lets the model choose a scene or presentation of the complete text. Preparation supplies the authored passage for mathematical facts and quantities, and canonical narration for spoken anchors. Blocks with imported diagrams preserve those authored visuals; existing prepared scenes keep their saved choice under the content cache contract.

When the model chooses formula spotlight, the complete formula and symbol names remain visible. A symbol is emphasized only during its exact narration quotation; an empty anchor keeps an unmentioned symbol static. Bases, subscripts, superscripts and operators have separate targets whenever the explanation distinguishes them. The [scene contract](../../../packages/shared-types/formulaSpotlight.ts) requires a formula with explicit symbol references and exact, unique, ordered anchors for the symbols that are mentioned. Validation checks rendered KaTeX targets, including macro expansions, and rejects authored HTML and URL commands. Formula validation, display and legend notation share a maximum explicit KaTeX dimension of 2 em; macro expansion uses the library default. Mathematical faithfulness remains part of scene generation and its provider verification. A structural MathML comparison retains sourced equations when a spotlight omits or changes an authored expression.

The [shared reference resolver](../../../packages/shared-types/formulaSpotlight.ts) produces bounded source spans from canonical narration. The [stage](../../../apps/web/components/workspace/playback/LessonPlaybackStage.tsx) maps their start and end onto the existing word-width timing estimate, without the caption lookahead, so normal playback and forward or backward seeking update the formula and legend together. Spoken pronunciations, captions, motion and audio use the same canonical narration while source spans retain their original Markdown ranges. [Formula rendering](../../../apps/web/components/shared/lessonScene/FormulaSpotlight.tsx) uses the scene's explicit symbol bindings; resize measurements are coalesced into animation frames and cancelled on unmount.

## Adopt results only for the matching content

Preparation identifies the project incarnation, section, lesson content key, block, voice and speech model. These identities let persistence attach the audio and cues to the content that requested them. Otherwise, a changed lesson could receive a valid audio file that narrates its earlier version. [Asset adoption](../04-section-data/02-p-asset-management.md) owns the stored file references.

Preparation requests for different blocks run independently. Voices of the same block share an active run, preserving one canonical narration and classification. The accepted response identifies whether this request created that run; the browser cancels only work it owns and waits for cancellation to settle before requesting the same block again. Creation responses remain observable after a seek or pause so late ownership can still be released.

Speech synthesis uses the backend's [OpenRouter speech client](../../../apps/backend/src/services/ttsClient.ts), which resolves model-specific voices and normalizes supported responses. A Codex text connection therefore still needs OpenRouter for narration.

## Keep narration ready for the next passage

The [playback hook](../../../apps/web/hooks/reader/useLessonPlayback.ts) requests at least thirty seconds of upcoming audio with two concurrent block preparations. Playback speed scales that horizon. Starting, resuming, seeking and changing voice wait only for the recording at the selected position. The upcoming horizon fills in the background; each completion appends the contiguous ready prefix. If narration reaches an unprepared passage, the player shows its loading state and resumes that passage when its existing preparation completes. A project revision notification wakes the availability check; periodic checks recover missed notifications.

The browser downloads and decodes recordings during preparation. The [audio transport](../../../apps/web/utils/reader/lessonPlaybackAudio.ts) appends their samples to one Signalsmith Stretch worklet, so a prepared passage follows its predecessor on the same audio clock. Playback rate and pitch are controlled separately. The pinned library carries the upstream [multi-buffer read correction](https://github.com/Signalsmith-Audio/signalsmith-stretch/pull/30), with a regression that compares its real WASM output against a single-buffer stream. The context is created and resumed in the opening gesture, and playback is scheduled at its current time once the ready buffer is available. Passage positions derive from that clock for captions, visuals and notes. Seeking and changing voice rebuild the selected stream; pausing and closing cancel obsolete preparation. Closing releases the context and decoded recording cache.

Signalsmith's complete module is a versioned Vite asset loaded into the worklet scope. Constructor and WASM initialization exceptions return an explicit failure message. Initialization, processor and context failures reject pending audio operations and expose the player's retry state; an explicit retry creates a fresh audio session. CI builds the production frontend and exercises real AudioWorklets with a fixed local WAV in muted Chromium and Firefox, including failed initialization and retry. The installed-source streaming test separately checks sample equivalence across buffer boundaries.

With those results ready, the [reader](../05-section-frontend/01-p-reader-shell.md) owns seeking, speed and presentation. Reduced-motion preferences retain the visual while suppressing motion, leaving the explanation available under a different presentation preference.

Playback causal scenes use an ordered grid with numbered cards: two columns on desktop and one at the existing narrow scene-host query. Connectors use unscaled card positions to follow authored order across the row gap. The stage retains its caption and visual columns and fits the complete scene into the available area. The [causal grid](../../../apps/web/components/shared/lessonScene/CausalGrid.tsx) owns these cards and connectors.

## Keep the mathematical source available

The shared playback projection keeps each whitespace-separated formula group together. When the next passage explains that group, its equations remain available within the same authored heading. Scene preparation receives this source together with the current narration. The right panel presents a chosen visual with its sourced mathematics, or the sourced equations alone when no useful scene exists. With neither, the panel stays empty; narration prose remains in captions. Authored code, tables, diagrams and images retain their visual representation, including images embedded in mathematical prose. On narrow screens, a passage without a visual presents its captions.

Saved recordings and pronunciations remain reusable. These display and reference-span rules apply when cached lessons are rendered, without regenerating audio. Word positions within a recording remain estimates until an acoustic alignment is available.
