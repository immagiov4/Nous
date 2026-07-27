# Nous Reader — Brand and interface direction

This document is the source of truth for the public brand surface. The authenticated learning
interface continues to follow [`docs/UI_STYLE_GUIDE.md`](docs/UI_STYLE_GUIDE.md); both surfaces share
the same calm, reading-first character, but they have different jobs.

## Product promise

Nous turns source material into a continuous learning path. It is not presented as a generic chat,
file drive, or one-click summarizer. Every public-facing screen should make three ideas immediately
clear:

1. the learner brings a subject or source material;
2. Nous gives it a useful sequence;
3. reading, questions, annotations, and progress remain connected over time.

The primary audience includes people who struggle with cognitive overload or continuity between
study sessions. Simple hierarchy and a single obvious next action matter more than feature density.

## Name and mark

- Use **Nous Reader** for the public product name and **Nous** where the context is already clear.
- Use the owl in `apps/web/assets/logo.svg` as the primary mark.
- Pair the owl with the wordmark in navigation and footer contexts. The owl may stand alone for app
  icons and constrained controls.
- Keep the mark near-monochrome. Do not introduce a second mascot, a decorative hero owl, or an
  alternative `N` monogram without a deliberate brand review.

## Visual language

### Palette

| Role | Value | Use |
| --- | --- | --- |
| Paper | `#FCFAF7` | Primary public-page background |
| Surface | `#FFFFFF` | Inputs and the product preview |
| Ink | `#1A1917` | Primary text, dark sections, primary actions |
| Muted ink | `#66615B` | Explanatory copy |
| Faint line | `#EEE9E2` | Dividers and low-emphasis boundaries |
| Terracotta | `#C4622A` | Eyebrows, focus cues, and meaningful accents |
| Terracotta dark | `#9F451D` | Accent interaction state |

Terracotta is an accent, not a second background system. Avoid gradients and decorative color
effects. Contrast should come from typography, spacing, paper, and ink.

### Typography

- **Playfair Display**: marketing headlines and the public wordmark.
- **Inter**: interface labels, navigation, form controls, and supporting copy.
- **Merriweather**: long-form lesson copy inside the product and its faithful previews.
- **JetBrains Mono**: small sequence numbers and technical metadata.

Headlines should be compact and editorial, with restrained negative tracking. Body copy should stay
comfortable at roughly 1.6–1.8 line height. Do not use uppercase for paragraphs; reserve it for short
eyebrows and metadata.

### Shape, spacing, and elevation

- Prefer dividers and whitespace over collections of cards.
- Use full pills only for actions and compact controls. Product surfaces use modest radii rather than
  soft, inflated containers.
- Shadows are reserved for floating surfaces: the reader preview, modal access panel, and temporary
  menus.
- Public sections should be generous on desktop and linear on mobile. Every section needs one main
  idea, not a dashboard of equally weighted claims.

### Icons and imagery

- Use the existing `lucide-react` set for interface icons.
- Icons support a label or a familiar control; they do not replace important product language.
- Product previews must resemble the real reading experience and contain realistic content. Avoid
  placeholder boxes, abstract dashboards, decorative illustration, and fake charts.

## Public landing flow

The landing page follows one reading direction:

1. promise and waitlist;
2. real product preview;
3. three concise benefits;
4. how source material becomes a course;
5. differentiation from summaries, chat, and file storage;
6. audience fit;
7. final waitlist action.

The preview is invite-only. The waitlist is the primary conversion. Existing testers can open the
sign-in panel from the secondary **Accedi** action without leaving the page.

## Responsive and accessible behavior

- At narrow widths, navigation collapses and the page becomes a single uninterrupted column.
- The product preview drops its outline sidebar before its lesson content becomes cramped.
- Inputs and actions fill the available width on small phones.
- All interactive controls require visible keyboard focus, descriptive accessible names, and at
  least a comfortable touch target.
- Motion is brief and functional. Respect `prefers-reduced-motion` and never make progress or content
  comprehension depend on animation.
- User-facing failures are stable and useful. Internal stack traces, infrastructure messages, and
  provider details never appear in the interface.
