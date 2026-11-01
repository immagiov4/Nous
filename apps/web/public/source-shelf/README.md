# Shared source-shelf book

Generated with OpenAI GPT Image through the native `image_gen` tool on 2026-11-01, editing the maintainer-approved candidate A / study 1. One neutral transparent book is reused for every source. CSS multiplies the six palette colours through a cloth-only alpha mask; the page block and edge highlights retain their original colours. Index, title and file type remain live HTML. No source content was sent to the image tool.

Prompt: "Use case: precise-object-edit. Edit target: the attached study 1 linen hardcover book. Produce ONE isolated blank book for a web UI sprite, with actual transparent background. Preserve this same adorable soft rounded silhouette, near-front orthographic camera, slightly visible top pale page block and right page edges, gently convex rounded left spine and delicate woven-linen tactile cloth. Change ONLY the binding cloth to very light near-white neutral greige (almost white, no yellow cast), suitable for later multiply recolouring in CSS. Page block stays natural pale ivory. The broad front cover is blank, no lettering, symbols, numbers or ornament. Keep its front plane nearly frontal with the slight downward-right slope in the reference; upright vertical spine; enough blank face for live HTML titles. Soft diffuse upper-left light preserves weave, rounded bevels and shallow fold by spine. No floor, no pedestal, no baked ground shadow, no rectangular background or checkerboard; transparent pixels everywhere outside book. Whole book fully in frame with small even transparent margin. One single book only. Do not create colour variants."

Export: the 1086 × 1448 RGBA master is cropped to (105,100)–(985,1375), resized with Lanczos to fit 280 × 384 and centred in a 300 × 400 transparent canvas. `book-neutral.webp` uses quality 88 and is 14,224 bytes. `book-cloth-mask.webp` (6,016 bytes) uses the same crop and scale, with the master's alpha restricted to the cloth polygon (116,161), (176,156), (905,196), (905,1354), (865,1370), (150,1300), (116,1280). These two shared assets total 20,240 bytes; palette changes never alter the silhouette. The former tiling cloth/pages atlas is replaced by this render.

The cover's affine transform is fitted to the front face of this export. Keep render, mask and transform registered when replacing the artwork. `e2e/nous/tests/sourceShelf.browser.ts` samples the tinted front-face pixels for text contrast, captures both themes at desktop/mobile sizes and records keyboard, upload, removal and reduced-motion evidence outside Git.


## Approved single-book source-preparation motion

During preparation one large, fixed-camera book represents the active source. The ordered strip uses static source thumbnails with persistent completion/error marks. The original neutral book and six-color cloth palette remain the attachment-selection artwork. Source names remain bounded HTML text with full accessible names.

The maintainer accepted the single-book blue/copper/sage composition on 2026-11-01, including occasional visible frame glitches in the prototype. These are actual Blender cover/spine material variants of the rounded reference model, with a bookmark present from the first pose and a matching magnifier. The camera is constant and turned sheets remain stacked. No private source content was used.

Each `preparation-{blue,copper,sage}-` set contains:

| Suffix | Source frames | Purpose |
| --- | --- | --- |
| `reading.webm` | 1–152, 24 fps | Opening and forward reading |
| `search.webm` | 153–178, 12 fps | Forward closed search trajectory, never reversed footage |
| `complete.webm` | 179–230, 24 fps | Closure only when the source is actually done |
| `closed.webp` | 1 | Queued/error thumbnail and initial poster |
| `reading.webp` | 152 | Reading fallback and clip-boundary poster |
| `complete.webp` | 230 | Completed thumbnail/poster |

Videos are 512×512 VP9 with alpha; posters are lossless WebP with alpha. A single native player retains its DOM identity across polling updates and clip changes, and is replaced only for a different source. Queued/fast-completed sources use stills. Opaque alpha, failed decoding or rejected autoplay retain static artwork. Reduced motion uses stills; hidden/unmounted media pauses. Playback never completes or delays backend preparation.

Editable Blender scenes and transparent frame sequences remain in the external approved task artifacts. Native playback, source identity, warnings, cancellation and poster fallback are verified by `test:source-preparation-shelf` and shelf component tests.
