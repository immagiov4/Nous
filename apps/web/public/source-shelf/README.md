# Shared 3D source-shelf books

Attachment selection uses the same closed blue/copper/sage Blender book posters as preparation. Index, extension and bounded filename remain live HTML below the artwork; full filenames remain accessible. All palettes share geometry, camera, paper and magnifier materials. No source content is baked into the assets.

## Source-preparation carousel

During preparation a single ordered carousel centers and enlarges the active source. Other sources remain beside it; a source that has been visibly read finishes closing as the next source moves to the center. Completed and failed sources retain their distinct marks. Visible names use a single truncated line; the full filename remains accessible.

The maintainer accepted the single-book blue/copper/sage 3D artwork on 2026-11-01, including occasional visible frame glitches in the prototype. These are actual Blender cover/spine material variants of the rounded reference model, with a bookmark present from the first pose and a matching magnifier. The camera is constant and turned sheets remain stacked. No private source content was used.

Each `preparation-{blue,copper,sage}-` set contains:

| Suffix | Source frames | Purpose |
| --- | --- | --- |
| `reading.webm` | 1–152, 24 fps | Opening and forward reading |
| `search.webm` | 153–178, 12 fps | Forward closed search trajectory, never reversed footage |
| `complete.webm` | 179–230, 24 fps | Closure only when the source is actually done |
| `closed.webp` | 1 | Queued/error thumbnail and initial poster |
| `reading.webp` | 152 | Reading fallback and clip-boundary poster |
| `complete.webp` | 230 | Completed thumbnail/poster |

Videos are 512×512 VP9 with alpha; posters are lossless WebP with alpha. Each keyed source retains its native player across polling updates and clip changes. When a reading source completes during its opening, it finishes opening and then closes without looping while the next source starts. A newly loaded clip explicitly resumes playback when visible. Queued/fast-completed sources use stills. Opaque alpha, failed decoding or rejected autoplay retain static artwork. Reduced motion uses stills; hidden/unmounted media pauses. Playback never completes or delays backend preparation.

Editable Blender scenes and transparent frame sequences remain in the external approved task artifacts. Native playback, source identity, warnings, cancellation and poster fallback are verified by `test:source-preparation-shelf` and shelf component tests.
