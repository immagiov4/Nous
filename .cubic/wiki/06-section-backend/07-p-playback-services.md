<details>
<summary>Relevant source files</summary>

The following files were used as context for generating this wiki page:

- [apps/backend/src/services/lessonPlayback/prepareLessonPlaybackBlock.ts](https://github.com/immagiov4/Nous/blob/21ec8b9ef2e9c48eae54d59ba738a6dc8f10dee6/apps/backend/src/services/lessonPlayback/prepareLessonPlaybackBlock.ts)
- [packages/shared-types/lessonPlayback.ts](https://github.com/immagiov4/Nous/blob/21ec8b9ef2e9c48eae54d59ba738a6dc8f10dee6/packages/shared-types/lessonPlayback.ts)
- [packages/shared-types/lessonPlaybackSchema.ts](https://github.com/immagiov4/Nous/blob/21ec8b9ef2e9c48eae54d59ba738a6dc8f10dee6/packages/shared-types/lessonPlaybackSchema.ts)
- [apps/backend/tests/projects/lessonPlayback.test.ts](https://github.com/immagiov4/Nous/blob/21ec8b9ef2e9c48eae54d59ba738a6dc8f10dee6/apps/backend/tests/projects/lessonPlayback.test.ts)
- [apps/backend/src/services/lessonScenes/lessonSceneGeneration.ts](https://github.com/immagiov4/Nous/blob/21ec8b9ef2e9c48eae54d59ba738a6dc8f10dee6/apps/backend/src/services/lessonScenes/lessonSceneGeneration.ts)
- [packages/shared-types/lessonScene.ts](https://github.com/immagiov4/Nous/blob/21ec8b9ef2e9c48eae54d59ba738a6dc8f10dee6/packages/shared-types/lessonScene.ts)
</details>

# Backend Playback Services

Backend Playback Services process lesson content into a multimodal experience by generating synchronized audio and structured visuals. These services segment authored Markdown text, resolve mathematical pronunciations, and orchestrate the generation of educational scenes that align with the spoken narration.

The system ensures that each playback session remains consistent with the authored source through a deterministic fingerprinting mechanism. When a user opens a lesson, the backend prepares the necessary assets—including Text-to-Speech (TTS) files and visual animation cues—to allow the frontend player to highlight specific symbols and concepts in real-time.

## Core Architecture and Data Flow

The playback system operates on a pipeline that transforms raw content blocks into a structured `LessonPlayback` object. This object contains a series of `LessonPlaybackBlock` units, each representing a narrated segment with associated visuals.

### Playback Preparation Lifecycle

The lifecycle begins with the segmentation of lesson Markdown into logical blocks based on headings and paragraph structures. Once segmented, the service prepares each block by generating audio and resolving visual cues.

```mermaid
flowchart TD
    Start[Authored Lesson Content] --> Seg[segmentLessonPlayback]
    Seg --> Block[LessonPlaybackBlock]
    Block --> Prep[prepareLessonPlaybackBlock]
    
    subgraph Preparation
        Prep --> Audio[prepareAudio / TTS]
        Prep --> Visuals[prepareLessonPlaybackVisuals]
        Visuals --> Scene[generateLessonScene]
        Visuals --> Motion[planPlaybackMotion]
        Scene --> Icons[chooseLessonSceneIcons]
    end
    
    Audio --> Output[PreparedLessonPlaybackBlock]
    Motion --> Output
    Icons --> Output
```
*Diagram 1: The backend pipeline for transforming authored content into prepared playback assets.*
Sources: [apps/backend/src/services/lessonPlayback/prepareLessonPlaybackBlock.ts](https://github.com/immagiov4/Nous/blob/21ec8b9ef2e9c48eae54d59ba738a6dc8f10dee6/apps/backend/src/services/lessonPlayback/prepareLessonPlaybackBlock.ts), [packages/shared-types/lessonPlayback.ts](https://github.com/immagiov4/Nous/blob/21ec8b9ef2e9c48eae54d59ba738a6dc8f10dee6/packages/shared-types/lessonPlayback.ts)

### Invalidation and Caching

To prevent redundant processing, the system uses a `lessonKey` to fingerprint the state of a lesson. Any change to the lesson content, such as modifying text or updating a referenced visual, invalidates the existing playback key and triggers a re-preparation of the audio and visual assets.

*   **Fingerprint Factors:** The key includes projected speech, referenced visual IDs, and the content of stored visuals.
*   **Persistent State:** Ordinary saves preserve server-side playback data unless the content is explicitly replaced or the generation ID changes.
*   **Audio Queueing:** When playback is invalidated, the system queues new audio generation for the affected sections.

Sources: [apps/backend/tests/projects/lessonPlayback.test.ts](https://github.com/immagiov4/Nous/blob/21ec8b9ef2e9c48eae54d59ba738a6dc8f10dee6/apps/backend/tests/projects/lessonPlayback.test.ts)

## Data Models

The following structures define the contract between the playback services and the rest of the application.

### LessonPlaybackBlock
The `LessonPlaybackBlock` is the primary unit of delivery. It contains the text to be spoken, the mapping back to the original source, and the prepared assets.

| Field | Type | Description |
| :--- | :--- | :--- |
| `id` | `string` | Stable identifier for the block within a lesson version. |
| `speech` | `string` | The final text projected for Text-to-Speech narration. |
| `spans` | `PlaybackTextSpan[]` | Mappings between speech offsets and authored source offsets. |
| `visuals` | `PlaybackVisual[]` | List of visuals (Markdown, Scenes, or Images) associated with the block. |
| `prepared` | `Object` | Optional prepared data including `motion` events and the active `scene`. |
| `audio` | `PlaybackAudio[]` | References to generated MP3 assets and word alignment data. |

Sources: [packages/shared-types/lessonPlayback.ts](https://github.com/immagiov4/Nous/blob/21ec8b9ef2e9c48eae54d59ba738a6dc8f10dee6/packages/shared-types/lessonPlayback.ts), [packages/shared-types/lessonPlaybackSchema.ts](https://github.com/immagiov4/Nous/blob/21ec8b9ef2e9c48eae54d59ba738a6dc8f10dee6/packages/shared-types/lessonPlaybackSchema.ts)

### Lesson Scene Structure
Scenes are structured visual representations used to clarify complex relationships or processes.

```mermaid
classDiagram
    class LessonScene {
        +LessonSceneType type
        +string title
        +string body
        +LessonSceneItem[] items
        +LessonSceneGroup[] groups
        +string quote
        +string note
        +LessonSceneDiagram diagram
    }
    class LessonSceneItem {
        +string label
        +string detail
        +number value
        +string icon
    }
    class LessonSceneDiagram {
        +Node[] nodes
        +Edge[] edges
    }
    LessonScene "1" *-- "many" LessonSceneItem
    LessonScene "1" *-- "0..1" LessonSceneDiagram
```
*Diagram 2: The structured data model for generated lesson scenes.*
Sources: [packages/shared-types/lessonScene.ts](https://github.com/immagiov4/Nous/blob/21ec8b9ef2e9c48eae54d59ba738a6dc8f10dee6/packages/shared-types/lessonScene.ts), [apps/backend/src/services/lessonScenes/lessonSceneGeneration.ts](https://github.com/immagiov4/Nous/blob/21ec8b9ef2e9c48eae54d59ba738a6dc8f10dee6/apps/backend/src/services/lessonScenes/lessonSceneGeneration.ts)

## Key Service Operations

### Speech Preparation and Math Resolution
Authored Markdown often contains mathematical formulas that require specific pronunciations for effective TTS. 

1.  **Detection:** The service identifies math delimiters (`\(...\)`, `\[...\]`) and ambiguous fenced code blocks.
2.  **Projection:** It generates a "projected speech" version where math and code are replaced by model-generated prose.
3.  **Spoken Math:** `validatePlaybackSpokenMath` ensures that every formula occurrence has a corresponding pronunciation entry in the `prepared` metadata.
4.  **Alignment:** `preparePlaybackAudio` generates the MP3 and optionally requests word-level timing to allow the UI to highlight text during playback.

Sources: [packages/shared-types/lessonPlayback.ts](https://github.com/immagiov4/Nous/blob/21ec8b9ef2e9c48eae54d59ba738a6dc8f10dee6/packages/shared-types/lessonPlayback.ts), [apps/backend/src/services/lessonPlayback/prepareLessonPlaybackBlock.ts](https://github.com/immagiov4/Nous/blob/21ec8b9ef2e9c48eae54d59ba738a6dc8f10dee6/apps/backend/src/services/lessonPlayback/prepareLessonPlaybackBlock.ts)

### Visual and Motion Planning
`prepareLessonPlaybackVisuals` determines how the UI should behave as the narration progresses.

*   **Scene Generation:** If a block requires a visual, the service calls `generateLessonScene`. This process involves selecting a scene type (e.g., `checklist`, `comparison`, `flowchart`) based on the pedagogical context of the passage.
*   **Motion Events:** `planPlaybackMotion` identifies specific targets within a scene (e.g., a node in a diagram or a row in a matrix) and associates them with `focus` or `reveal` effects triggered by specific quotes in the narration.
*   **Animation Cues:** `resolvePlaybackAnimationCues` synchronizes the visual state transitions with the narration timing.

Studio selection ships disabled. Eligible visuals use the ordinary scene slot and catalog. The server setting `LESSON_STUDIO_SELECTION_ENABLED=true` enables selection for development and verification on lessons declared Italian. The backend logs `studioSelection: 'unsupported-language'` when the lesson language is missing or unsupported.

When selection is enabled, a visual with an owning narration block can use an array, heap, graph, function plot, Cartesian plane, trajectories, Space 3D or music studio. The model links trace events to numbered phrases. For arrays, heaps, weighted graphs, function plots, and planes, each complete operand list must appear in spec order in its cited phrase or in one exact quotation from the owning lesson section. Italian number words and written digits are supported. Section quotations can cite lists, complete Markdown rows, and supported equations with explicit operands. Axis ranges frame the drawing. Nous validates the operands, cues, computed geometry and motion timing before saving. A hold highlights an existing visible label when its exact name appears in the phrase. Playback uses the same geometry and maps both ends of the phrase to aligned audio when available.

Music covers scales, intervals, triads and rhythm grids. Staff notation loads on demand. Music drafts cite the declared key, any ordered chord degrees, and each displayed rhythm input in the narration or owning lesson section. Explicitly stated worked examples use the same citations. Rejected music drafts use the concepts catalog. Drum steps and chord bars use playback time at the displayed BPM.

Image annotation uses the same switch. The model names the visual concept, and Wikimedia retrieval supplies up to twelve eligible previews. The configured selector can decline the entire set. An accepted picture is measured from the raster bytes and stored with the scene's Commons credit as a project asset, so the reader and restored backups use their own stored copy. A failed attempt uses the existing catalog recovery.

The browser loads studio drawing code and font metrics when the reader or player displays a saved studio scene. Space 3D uses WebGL and shows the current narration phrase if rendering becomes unavailable. The renderer lays out the SVG in the measured plot's CSS pixels and redraws the current playback position after resizing. During listening, captions sit beside the studio up to 1600 CSS px and below it on wider screens. On phones the studio can open in a fullscreen landscape view.

For otherwise eligible passages, `studioSelection: 'disabled'` in the backend log explains why generation used the catalog directly. When enabled, `[lesson-studio] selected` or `[lesson-studio] fallback` records the decision and any failed checks. Each `operandEvidence` entry identifies a field, its source, and the zero-based UTF-16 range in the canonical narration or section excerpt. A numeric rejection has `reason: 'operand-grounding'` and the `rejectedField` path. The layout gate checks transitions at the measured reference sizes using estimated word timing. A layout rejection records the measured stage and checks under the same `decisionId` as the single `studio-repair` attempt and catalog recovery. A concepts scene preserves narration excerpts if catalog recovery fails. Use `decision_id` and `call_role` in workflow AI usage to find the associated calls. Image annotation logs the retrieval lane or failure stage under that same decision. Vision usage is tagged `studio-selection`.

Sources: [apps/backend/src/services/lessonPlayback/prepareLessonPlaybackBlock.ts](https://github.com/immagiov4/Nous/blob/21ec8b9ef2e9c48eae54d59ba738a6dc8f10dee6/apps/backend/src/services/lessonPlayback/prepareLessonPlaybackBlock.ts), [packages/shared-types/lessonPlayback.ts](https://github.com/immagiov4/Nous/blob/21ec8b9ef2e9c48eae54d59ba738a6dc8f10dee6/packages/shared-types/lessonPlayback.ts)

#### Studio reader measurements

The studio gate uses these reference rectangles from the local reader with a saved parabola scene. The runtime measures the space left by the actual window, caption panel and scene header.

| Window (CSS px) | Inline plot (CSS px) | Listening plot (CSS px) |
| --- | --- | --- |
| 1280 × 720 | 643.25 × 326.77 | 589.67 × 370.64 |
| 1440 × 900 | 643.25 × 326.77 | 675.45 × 550.64 |
| 1920 × 1080 | 643.25 × 326.77 | 1646.41 × 575.67 |
| 390 × 844 | 322 × 168 | 354 × 526.63 |
| 320 × 568 | 252 × 168 | 284 × 250.63 |
| 844 × 390, fullscreen | — | 780 × 206.64 |

### Workflow Sequence Diagram

This diagram illustrates the interaction between the preparation service and external providers during a typical block preparation request.

```mermaid
sequenceDiagram
    participant Srv as PrepareService
    participant AI as AI Provider
    participant TTS as TTS Provider
    participant Asset as Asset Service

    Srv->>AI: generateLessonScene (Context + Text)
    AI-->>Srv: Structured Scene Data
    Srv->>AI: chooseLessonSceneIcons (Item Queries)
    AI-->>Srv: Icon Mapping
    Srv->>TTS: preparePlaybackAudio (Projected Speech)
    TTS-->>Srv: MP3 Bytes + Word Alignment
    Srv->>Asset: reconcileProjectAssets (MP3)
    Asset-->>Srv: ProjectAssetRef
    Srv-->>Srv: Finalize PreparedBlock
```
*Diagram 3: Interaction flow for preparing audio and visual assets.*
Sources: [apps/backend/src/services/lessonPlayback/prepareLessonPlaybackBlock.ts](https://github.com/immagiov4/Nous/blob/21ec8b9ef2e9c48eae54d59ba738a6dc8f10dee6/apps/backend/src/services/lessonPlayback/prepareLessonPlaybackBlock.ts), [apps/backend/src/services/lessonScenes/lessonSceneGeneration.ts](https://github.com/immagiov4/Nous/blob/21ec8b9ef2e9c48eae54d59ba738a6dc8f10dee6/apps/backend/src/services/lessonScenes/lessonSceneGeneration.ts)

## Implementation Details

### Scene Catalog Requirements
The backend enforces strict rules for scene generation to ensure pedagogical quality:
*   **Independent Content:** `LESSON_SCENE_INDEPENDENT_CONTENT_RULE` mandates that scenes preserve every step or computation required by the teaching goal.
*   **Closing Text:** `LESSON_SCENE_CLOSING_TEXT_RULE` prevents redundant information by restricting notes and questions to essential cases.
*   **Diagram Constraints:** Flowcharts and sequence diagrams must have between 2 and 8 nodes and carry exact lesson quotations as evidence for every connection.

Sources: [apps/backend/src/services/lessonScenes/lessonSceneGeneration.ts](https://github.com/immagiov4/Nous/blob/21ec8b9ef2e9c48eae54d59ba738a6dc8f10dee6/apps/backend/src/services/lessonScenes/lessonSceneGeneration.ts), [packages/shared-types/lessonScene.ts](https://github.com/immagiov4/Nous/blob/21ec8b9ef2e9c48eae54d59ba738a6dc8f10dee6/packages/shared-types/lessonScene.ts)

### Audio Constraints
*   **Format:** The system explicitly requires `audio/mpeg` (MP3) for playback assets.
*   **Validation:** `canonicalizeLessonNodeContent` rejects any playback asset that does not match the canonical MP3 media type during import or save operations.

Sources: [apps/backend/tests/projects/lessonPlayback.test.ts](https://github.com/immagiov4/Nous/blob/21ec8b9ef2e9c48eae54d59ba738a6dc8f10dee6/apps/backend/tests/projects/lessonPlayback.test.ts), [packages/shared-types/lessonPlaybackSchema.ts](https://github.com/immagiov4/Nous/blob/21ec8b9ef2e9c48eae54d59ba738a6dc8f10dee6/packages/shared-types/lessonPlaybackSchema.ts)

Backend Playback Services integrate complex AI-driven visual generation with deterministic text processing and TTS. By centering preparation on the `LessonPlaybackBlock` and using robust fingerprinting, the system provides a low-latency, synchronized learning experience that remains faithful to the authored source material.

## Observability

When studio selection is enabled, a geometry rejection records the studio, the reader size in CSS pixels and the failed rule, including unequal axis scale where applicable. For the release default and its diagnostics, see [Visual and Motion Planning](#visual-and-motion-planning). [Selection diagnostics](../../../apps/backend/src/services/lessonScenes/lessonStudioSelection.ts)
