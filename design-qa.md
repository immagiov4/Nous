# Design QA — public landing

## Source target

- Reference: `.temp/landing_inspo.png`
- Product direction: `.temp/brand-brief.md` and GitHub discussion #33
- Implementation: `apps/web/components/marketing/LandingPage.tsx`

## Captures

- Desktop: `.temp/landing-implementation-desktop.png`
- Desktop viewport: 1680 × 945
- Mobile: `.temp/landing-implementation-mobile.png`
- Mobile viewport: 390 × 844
- State: unauthenticated public landing, English browser locale, waitlist idle

## Findings and iteration history

### Pass 1

- P0: none.
- P1: none.
- P2: hero content and reader preview started lower than the reference, reducing the amount of the
  value strip visible above the fold.
- P2: the initial benefit strip used numeric labels and a full-bleed divider treatment; the reference
  used a contained three-column panel with recognizable icons and short supporting copy.

### Fixes

- Widened the shared marketing page frame to align the brand and hero edges with the source.
- Reduced hero vertical padding and height, adjusted the column ratio, and enlarged the reader preview.
- Rebuilt the first-fold benefit strip as a contained three-column panel using the established Lucide
  icon set and source-aligned product claims.

### Pass 2

- Compared the source and implementation together at 1680 × 945.
- Verified hero hierarchy, paper/ink palette, owl wordmark, editorial typography, product-preview
  prominence, first-fold spacing, and benefit-strip structure.
- Verified the rest of the page at the same viewport: transformation steps, dark differentiation
  section, audience statement, final waitlist action, and footer.
- Verified mobile navigation, single-column hero, full-width form controls, reader-preview collapse,
  access dialog, and zero horizontal overflow at 390 × 844.
- Verified a fresh browser tab produced no console errors. The existing Tailwind CDN production
  warning is pre-existing and does not affect the landing interaction.

## Interaction checks

- Mobile menu opens and exposes all navigation actions.
- Navigation scrolls to the requested section.
- Tester sign-in remains hidden until **Accedi / Sign in** is selected.
- The access panel is keyboard-dismissible and remains usable at 390 px.
- Waitlist success and stable failure states are covered by component tests; HTTP normalization and
  status mapping are covered by service tests.

Final result: passed
