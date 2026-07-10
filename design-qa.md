# Design QA — public landing redesign

## Source target

- Reference: `.temp/landing_inspo.png`
- Product direction: `.temp/brand-brief.md` and GitHub discussion #33
- Implementation: `apps/web/components/marketing/LandingPage.tsx` and
  `apps/web/components/marketing/LandingProductDemo.tsx`

## Captures

- Desktop: `.temp/landing-implementation-desktop.png`
- Desktop viewport: 1680 × 945
- Mobile: `.temp/landing-implementation-mobile.png`
- Mobile viewport: 390 × 844
- State: public landing, English browser locale, waitlist idle

## Findings and iteration history

### Pass 1 — Fable critique

- P0: the product demo used a nested scroll area that trapped the page scroll.
- P1: multiple sections repeated the same abstract product claim without adding evidence.
- P1: `Inizia` and the waitlist action promised two different access paths.
- P1: the strongest product evidence was a narrow, secondary preview instead of the page's focal point.
- P2: the visual hierarchy stayed flat across repeated gray cards and the footer lacked credibility links.

### Fixes

- Replaced every conversion action with the single label **Richiedi accesso**.
- Rewrote the hero around a concrete input, output, and continuity promise rather than a category claim.
- Replaced the illustrative preview with a working reader experience and a concrete psychology course.
- Added useful Libreria, Generazione, and Lezione states.
- Made the embedded reader use document scrolling; no descendant in the demo has a scrollable
  `overflow-y` region.
- Removed the oversized process section and compressed the page around the hero, product experience,
  differentiation, and access request.
- Removed development-facing copy and repository claims from the public interface.
- Expanded the footer with product, access, privacy, and contact links.

### Pass 2 — reference and implementation comparison

- Compared the supplied reference and the live implementation at 1680 × 945.
- Verified the editorial serif/sans hierarchy, paper-and-ink palette, asymmetric hero composition,
  product prominence, contained borders, and orange accent remain aligned with the source direction.
- Verified the dark comparison creates a distinct visual peak and the page no longer repeats the same
  claim across interchangeable cards.
- Verified the mobile composition at 390 × 844: single-column hero, usable demo tabs, full-width form
  controls, no clipped content, and zero horizontal overflow.
- Verified the live demo has no nested scroll container and all three states remain usable without an
  API call.
- Verified the landing has no runtime console errors. The Tailwind CDN production warning is
  pre-existing and unrelated to the landing behavior.

### Pass 3 — density, alignment, and product-facing language

- P0: removed every piece of interface metacopy, including claims about implementation details,
  demo data, network behavior, and development visibility.
- P1: removed the misaligned and over-spaced process section.
- P1: aligned the product heading and product surface to the same container width.
- P1: replaced the empty Piano state with a compact course library and rebuilt Generazione as a
  legible course-construction state.
- P2: reduced vertical spacing across the hero, product, final conversion panel, and footer.
- Verified the regeneration control only changes the local demonstration state.

## Interaction checks

- Demo navigation switches between Libreria, Generazione, and Lezione.
- Libreria exposes a course, progress, last-opened lesson, and a direct continuation action.
- Generazione exposes the course outline and current construction progress without triggering a request.
- Navigation scrolls to the requested section through the page's root scroll.
- Tester sign-in remains hidden until **Accedi / Sign in** is selected.
- The access panel is keyboard-dismissible and remains usable at 390 px.
- Waitlist success and stable failure states are covered by component tests; HTTP normalization and
  status mapping are covered by service tests.

Final result: passed

## Reader controls — key concepts, audio, and settings

### Source and target state

- Reference: Codex Environment floating panel supplied by the user.
- Route: the VLAN lesson in project `5d31c240-5915-4747-8405-1da47f4ea721`.
- Desktop: 1280 × 900, light theme, key-concepts popover open.
- Tablet: 768 × 900, light theme, audio and reading-settings popovers checked separately.
- Mobile: 390 × 844, light theme, key-concepts bottom sheet open.

### Contract replay

- The desktop reading column remains centered and no longer allocates a grid column to learning aids.
- Key concepts open from the sticky header after Audio; the closed control is outline-only.
- The panel and each definition use matching down-to-open and up-to-close indicators.
- Counts are absent from both the desktop control and the mobile entry point.
- Definitions begin collapsed and expand independently without changing the lesson Markdown.
- The audio panel aligns its right edge with the audio control and opens directly below it on tablet.
- Reading settings no longer render a trailing divider after the last section.
- No runtime console errors were observed in the replayed reader states.

Final result: passed
