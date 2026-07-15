# Marketing home design QA

- Source visual truth: `C:\Users\giovb\dyad-apps\Ramingo\.codex\generated_images\019f661b-f96d-7d91-bd1d-88c61cc51d39\exec-5be58fd7-3a06-494d-b306-66631c1658f4.png`
- Revised illustration: `apps/web/public/marketing/hero-materials-to-tablet.png`
- Desktop implementation: `tmp/design-qa-home-desktop.png`
- Mobile implementation: `tmp/design-qa-home-mobile.png`
- Sticky journey implementation: `tmp/design-qa-journey-centered-full.png`
- Desktop viewport: 1832 x 806
- Mobile viewport: 390 x 844 requested; browser content viewport reported 375 px after scrollbar allocation
- State: public `/landing`, English browser locale, logged-in session intentionally ignored by the public route

## Full-view comparison evidence

The selected third direction and the rendered desktop landing were opened in the same comparison input. The implementation preserves the selected editorial hierarchy, warm paper palette, serif headline, compact waitlist form, and left-to-right transformation illustration. The destination notebook was intentionally replaced by the requested vertical tablet. The quote styling and attribution were intentionally removed per the follow-up direction.

## Focused comparison evidence

A separate crop was not needed: at 1832 x 806 the headline, form, illustration edges, tablet bezel, progress marks, and transparency boundary were all legible in the full-view comparison. The standalone alpha asset was also inspected at its native 1675 x 939 resolution; all four corners are transparent and its alpha bounding box is plausible.

## Findings

- No actionable P0, P1, or P2 mismatch remains.
- P3: the live illustration is slightly smaller than the generated concept because it respects the existing 92 rem page grid. This keeps the form width and mobile breakpoint unchanged and is an acceptable production constraint.
- The hero illustration is hidden below 52 rem, matching the existing mobile information hierarchy and preventing horizontal overflow.
- The sticky product preview keeps the Remotion 3:2 ratio inside a viewport-height sticky slot. At the measured 1231 x 692 browser state, the visible video had 85.1 px above and 84.8 px below, a 1.5000 ratio, and no horizontal overflow.

## Interaction and runtime checks

- Public landing loaded with the generated PNG and no console errors.
- Desktop navigation contains only How it works, Sign in, and Request access.
- The journey section opens directly with its heading; the discarded PowerPoint/exam line is absent.
- Mobile menu opened and closed successfully.
- Mobile document width did not overflow its client width.
- The mobile contact row keeps the brand and email in the same flex row; the breakpoint no longer forces a column layout.
- Journey copy now describes original-source access, in-lesson visual and interactive aids, notes, course-wide questions, exam review, and flashcards without repeating device availability.
- Generation-progress evidence frames were inspected at 177/178 and 217/218. The active top stage and newest visible outline item now advance on the same timeline boundaries.
- Published Italian and English journey videos were probed as H.264, 2400 x 1600, 30 fps, yuv420p, limited-range BT.709, and 110 seconds.

## Comparison history

- Initial source issue: destination looked like a paper notebook and the subtitle looked like an attributed quote.
- Fix: generated a tablet-specific transparent asset, replaced the CSS card scene, and rendered the quote content as the normal hero subtitle without quotation marks or attribution.
- Post-fix evidence: desktop and mobile screenshots above; no remaining P0/P1/P2 findings.
- Later sticky-preview issue: centering with a translated sticky element pulled the preview upward into the hero, while a fixed-height container introduced letterboxing.
- Fix: keep the sticky slot in normal flow at viewport height and center the shared 3:2 video inside it. Composition dimensions, embed ratio, and the responsive test now share one source constant.
- Post-fix evidence: browser geometry shows balanced 85 px top/bottom spacing, exact 3:2 sizing, no hero overlap at page load, and no horizontal overflow.

final result: passed
