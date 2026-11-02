# Shared 3D source-shelf books

Attachment selection uses the same closed blue/copper/sage Blender book posters as preparation. Index, extension and bounded filename remain live HTML below the artwork; full filenames remain accessible. All palettes share geometry, camera, paper and magnifier materials. No source content is baked into the assets.

## Source-preparation carousel

During preparation a single ordered carousel centers and enlarges the active source. Other sources remain beside it; a source that has been visibly read finishes closing as the next source moves to the center. Completed and failed sources retain their distinct marks. Visible names use a single truncated line; the full filename remains accessible.

The maintainer accepted the single-book blue/copper/sage 3D artwork on 2026-11-01, including occasional visible frame glitches in the prototype. These are actual Blender cover/spine material variants of the rounded reference model, with a bookmark present from the first pose and a matching magnifier. The camera is constant and turned sheets remain stacked. No private source content was used.

Each `preparation-{blue,copper,sage}-` set contains:

| Suffix | Source frames (24 fps) | Purpose |
| --- | --- | --- |
| `reading.webm` | 1–61 | Cover eases open over 1.5 s, the first sheet follows, magnifier settles on the first line |
| `search.webm` | 62–141 | Seamless forward loop: reads two lines, steps aside while one sheet turns, returns |
| `complete.webm` | 142–196 | Magnifier lifts away, sheets fold back, cover closes softly and rests |
| `closed.webp` | 1 | Queued/error thumbnail and initial poster |
| `reading.webp` | 62 | Reading fallback and clip-boundary poster |
| `complete.webp` | 196 | Completed thumbnail/poster |

Motion revision (2026-11-02): every clip boundary is the same rendered rest pose (frames 61→62, 141→62 and 141→142 join without a cut; the loop wrap differs only by a turned sheet's ~1 px thickness). When a source is actually done, the playing loop pass stops looping and ends at that pose before the book closes, so completion never cuts mid-gesture; the done mark is immediate. The carousel's book resize and track glide share one 850 ms ease-in-out curve (`utils/motion/glideScroll.ts`, `sourceShelf.css`). Scene source and seam/clearance checks: external `pr-533-motion-opus/build.py` and `encode.py`.

Videos are 512×512 VP9 with alpha; posters are lossless WebP with alpha. Each keyed source retains its native player across polling updates and clip changes. A newly loaded clip explicitly resumes playback when visible. Queued/fast-completed sources use stills. Opaque alpha, failed decoding or rejected autoplay retain static artwork. Reduced motion uses stills and no resize/glide; hidden/unmounted media pauses. Playback never completes or delays backend preparation.

Editable Blender scenes and transparent frame sequences remain in the external approved task artifacts. Native playback, source identity, warnings, cancellation and poster fallback are verified by `test:source-preparation-shelf` and shelf component tests.
