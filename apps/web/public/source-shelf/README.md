# Shared 3D source-shelf books

Attachment selection uses the same closed blue/copper/sage Blender book posters as preparation. Index, extension and bounded filename remain live HTML below the artwork; full filenames remain accessible. All palettes share geometry, camera, paper and magnifier materials. No source content is baked into the assets.

## Source-preparation carousel

During preparation a single ordered carousel centers and enlarges the active source. Other sources remain beside it; a source that has been visibly read finishes closing as the next source moves to the center. Completed and failed sources retain their distinct marks. Visible names use a single truncated line; the full filename remains accessible.

The maintainer accepted the single-book blue/copper/sage 3D artwork on 2026-11-01, including occasional visible frame glitches in the prototype. These are actual Blender cover/spine material variants of the rounded reference model, with a bookmark present from the first pose and a matching magnifier. The camera is constant and turned sheets remain stacked. No private source content was used.

Each `preparation-{blue,copper,sage}-` set contains:

| Suffix | Purpose |
| --- | --- |
| `reading.webm` | Cover opens, the first sheet follows, magnifier settles on the first line |
| `search.webm` | Seamless forward loop: reads two lines, steps aside while one sheet turns, returns |
| `complete.webm` | Magnifier lifts away, sheets fold back, cover closes softly and rests |
| `closed.webp` | Queued/error thumbnail and initial poster |
| `reading.webp` | Reading fallback and clip-boundary poster |
| `complete.webp` | Completed thumbnail/poster |

Videos are 512×512 VP9 with alpha; posters are lossless WebP with alpha. Clip boundaries use a shared rendered rest pose; the loop wrap differs only by a turned sheet's approximately 1 px thickness.

The scene and encoder share [timeline.py](../../../../../scripts/source-shelf/timeline.py) for frame rate, choreography, clip boundaries and poster frames. Scene generation and seam/clearance checks live in [build.py](../../../../../scripts/source-shelf/build.py) and [encode.py](../../../../../scripts/source-shelf/encode.py).

## Regenerate the assets

Use Blender 3.0 (Eevee), FFmpeg with libvpx-vp9, and Python with Pillow and NumPy. From the repository root, render each palette:

```sh
blender -b --python-exit-code 1 --python scripts/source-shelf/build.py -- alpha blue
blender -b --python-exit-code 1 --python scripts/source-shelf/build.py -- alpha copper
blender -b --python-exit-code 1 --python scripts/source-shelf/build.py -- alpha sage
python scripts/source-shelf/encode.py apps/web/public/source-shelf
```

Replace `alpha` with `check` to run geometry and clearance assertions without rendering. Each palette directory receives the editable scene and geometry report; encoding prints pixel seam measurements. Generated working files stay beside the scripts and are ignored by Git.
