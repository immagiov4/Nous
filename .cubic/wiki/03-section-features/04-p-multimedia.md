---
title: "Narration and synchronized playback"
wiki_page_id: "p-multimedia"
---

[Up one level](../05-section-frontend/01-p-reader-shell.md)

# Narration and synchronized playback

Playback prepares a saved lesson as blocks with narration, visual references and timing cues. Its input includes the project incarnation, section, lesson content key, block, voice and speech model, so preparation can be tied to the content that requested it. The browser renders the prepared result rather than generating speech inside the player.

## Prepare a block, then adopt it

The [playback workflow](../../../apps/backend/src/workflows/lessonPlaybackWorkflow.ts) separates provider preparation from persistence. The [block preparation service](../../../apps/backend/src/services/lessonPlayback/prepareLessonPlaybackBlock.ts) validates speech and scene compatibility, prepares spoken mathematics where needed, then prepares audio and visuals concurrently. Both operations settle before failure propagates, preventing a retry from overlapping unfinished paid work from that attempt.

Existing scene references can provide the visual context. A block without visuals can request a scene grounded in its own speech; lesson metadata alone may describe another passage and is excluded from that evidence. Motion cues attach explanation points to scene elements. Blocks with several scenes keep them visible without an ambiguous motion target.

The saved result carries audio metadata and visual cues for the target block. [Persistence](../04-section-data/02-p-asset-management.md) adopts the audio asset for the matching lesson state; derived audio is excluded from portable project backups and can be regenerated.

## Speech and rendering have separate contracts

Text generation can use the configured AI provider, while speech synthesis goes through the backend's [OpenRouter TTS client](../../../apps/backend/src/services/ttsClient.ts). That client resolves model-specific voices and normalizes supported audio responses; playback preparation produces the audio format consumed by the player. A Codex text connection alone therefore does not supply narration.

The reader owns pause, seeking, speed and presentation state. Formula spans connect spoken mathematics to the highlighted symbols shown in the README illustration. Reduced-motion preferences preserve the visual while suppressing motion. These browser concerns live beside [reader composition](../05-section-frontend/01-p-reader-shell.md); model output and audio preparation belong on the backend side of the boundary.
