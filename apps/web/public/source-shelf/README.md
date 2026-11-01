# Shared source-shelf book

Generated with OpenAI GPT Image through the native `image_gen` tool on 2026-11-01, editing the maintainer-approved candidate A / study 1. One neutral transparent book is reused for every source. CSS multiplies the six palette colours through a cloth-only alpha mask; the page block and edge highlights retain their original colours. Index, title and file type remain live HTML. No source content was sent to the image tool.

Prompt: "Use case: precise-object-edit. Edit target: the attached study 1 linen hardcover book. Produce ONE isolated blank book for a web UI sprite, with actual transparent background. Preserve this same adorable soft rounded silhouette, near-front orthographic camera, slightly visible top pale page block and right page edges, gently convex rounded left spine and delicate woven-linen tactile cloth. Change ONLY the binding cloth to very light near-white neutral greige (almost white, no yellow cast), suitable for later multiply recolouring in CSS. Page block stays natural pale ivory. The broad front cover is blank, no lettering, symbols, numbers or ornament. Keep its front plane nearly frontal with the slight downward-right slope in the reference; upright vertical spine; enough blank face for live HTML titles. Soft diffuse upper-left light preserves weave, rounded bevels and shallow fold by spine. No floor, no pedestal, no baked ground shadow, no rectangular background or checkerboard; transparent pixels everywhere outside book. Whole book fully in frame with small even transparent margin. One single book only. Do not create colour variants."

Export: the 1086 × 1448 RGBA master is cropped to (105,100)–(985,1375), resized with Lanczos to fit 280 × 384 and centred in a 300 × 400 transparent canvas. `book-neutral.webp` uses quality 88 and is 14,224 bytes. `book-cloth-mask.webp` (6,016 bytes) uses the same crop and scale, with the master's alpha restricted to the cloth polygon (116,161), (176,156), (905,196), (905,1354), (865,1370), (150,1300), (116,1280). These two shared assets total 20,240 bytes; palette changes never alter the silhouette. The former tiling cloth/pages atlas is replaced by this render.

The cover's affine transform is fitted to the front face of this export. Keep render, mask and transform registered when replacing the artwork. `e2e/nous/tests/sourceShelf.browser.ts` samples the tinted front-face pixels for text contrast, captures both themes at desktop/mobile sizes and records keyboard, upload, removal and reduced-motion evidence outside Git.


## Approved source-preparation motion

During preparation, the shelf uses transparent Blender renders from the maintainer-approved fixed-camera Opus 5.5 revision (2026-11-01). The original neutral book and cloth palette remain the attachment-selection artwork. All source names remain HTML text, not baked into the shared animation.

| Asset | Approved source frames at 24 fps | Purpose |
| --- | --- | --- |
| `preparation-reading.webm` | 1–178 | Opening and reading, with no completion or upper bookmark |
| `preparation-search.webm` | 178–152 then 152–178 | Seamless search loop retaining both turned sheets while preparation is pending |
| `preparation-complete.webm` | 179–230 | Closure and gradual bookmark, started only after a source that visibly played becomes done |
| `preparation-closed.webp` | 1 | Waiting/error poster |
| `preparation-reading.webp` | 156 | Reduced-motion/unavailable-playback reading poster |
| `preparation-complete.webp` | 230 | Completed poster |

Videos are 512×512 VP9 with alpha; posters are lossless WebP with alpha. Only reading/completing books decode video; queued and fast-completed sources use still images. The browser checks the decoded transparent corner and keeps a poster if the alpha plane is unavailable, decoding fails or autoplay is rejected. Reduced motion uses stills. Playback pauses when the page is hidden or the artwork unmounts. Animation playback cannot complete or delay the source-preparation job.

The approved editable Blender/GLB scene and full transparent frame sequence remain in the external task artifacts. Runtime clips/posters are checked in here; no private course content is included. Native media playback, actual source state transitions and the poster fallback are verified by `test:source-preparation-shelf` and the shelf component tests.
