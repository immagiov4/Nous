# UI Style Guide

This file documents the visual patterns already established in Nous Reader.
Use it as the default reference before changing or adding frontend UI.

## Purpose

- Preserve a consistent interface across reading, library, chat, and laboratory flows.
- Reuse the visual language already present in the codebase instead of inventing local styles.
- Reduce recurring regressions such as over-carding, low-contrast badges, detached sidebars, and palette drift.

## Core Principles

- Prefer the existing product language over introducing a new local design system.
- Reading-oriented screens should feel like a continuous document, not a dashboard.
- Use cards only for genuinely self-contained units: popup panels, chat surfaces, attachment editors, modal-like blocks.
- Prefer structure through spacing, typography, and separators before reaching for extra borders, shadows, or nested containers.
- When a control is self-explanatory by icon and placement, avoid redundant text labels.

## Layout Patterns

### Reading Flows

- Reader-style pages should use the same shell as the lesson view: a wide outer container with a centered reading column.
- Default shell: `max-w-[90rem] px-4 pb-36 pt-8 sm:px-8 lg:px-14 xl:px-20 2xl:px-24`.
- Default reading column: `mx-auto max-w-[82ch]`.
- Focus mode can narrow the shell and reading column, but the same single-column reading logic still applies.
- For lesson, laboratory, and other long-form learning content, prefer one main column over detached sidebars unless the sidebar is an always-available utility.

### Sidebars

- The study sidebar is a neutral structural element, not a decorative card stack.
- Sidebar groups use plain rows, subtle hover states, and vertical rails (`border-l`) for nested items.
- Do not wrap sidebar subsections in extra cards unless there is a materially different interaction model.

### Floating Panels And Popovers

- Floating panels can be more elevated than reading surfaces.
- Use rounded outer containers, stronger shadows, and higher contrast borders.
- Popup-like neutral pills and badges should visually belong to these surfaces.
- Only one popup/popover may be open at a time. Opening one must close any other.

#### Tier 1 — Settings & Controls (lighter surface)

- Short-lived panels the user opens, adjusts, and dismisses quickly.
- Examples: model settings, audio panel.
- Typical surface:
  - Light: `border-gray-200 bg-white`
  - Dark: `dark:border-zinc-600/80 dark:bg-[var(--bg-surface)]`
- These use `var(--bg-surface)` in dark mode so they sit slightly above the page background without competing with deeper overlays.

#### Tier 2 — Contextual Overlays (deeper surface)

- Panels that appear in response to a user action on highlighted content or contextual triggers.
- Examples: context menu, annotation note, regenerate confirmation.
- Typical surface:
  - Light: `border-gray-200 bg-white`
  - Dark: `dark:border-zinc-600/80 dark:bg-stone-700` or `dark:bg-stone-800`
- These use `stone` in dark mode for stronger contrast against the reading surface, signaling higher contextual importance.

## Color System

### Base Palette

- The default UI palette is neutral and built around `gray`, `zinc`, and selected `stone` usages.
- Main content surfaces should usually stay in `gray` and `zinc`.
- Body text typically uses:
  - Light: `text-gray-900`, `text-gray-800`, `text-gray-700`, `text-gray-600`
  - Dark: `text-white`, `text-gray-100`, `text-zinc-300`, `text-zinc-400`
- Standard borders typically use `border-gray-200`, `border-gray-300`, `dark:border-zinc-700`, or `dark:border-zinc-600/80`.

### Where To Use `stone`

- `stone` is not the default for every surface.
- Reserve `stone` primarily for:
  - dark popup and floating panel backgrounds
  - selected filled controls (`bg-stone-900` in light, `dark:bg-stone-100` in dark)
  - chat bubbles and high-emphasis surfaces already using that contrast pattern
- Avoid introducing `stone` blocks into ordinary reading sections when `gray`/`zinc` already carries the surrounding UI.

### Accent Colors

- Orange and amber are accent colors, not the base UI palette.
- Use them for:
  - loading and generative energy
  - contextual emphasis already present in reading content
  - warning or attention states when semantically appropriate
- Do not tint entire neutral sections amber just to make them feel special.

### Semantic States

- Error and destructive: `red`
- Warning / caution / callout: `amber`
- Success / evaluation outcome: `emerald`
- Keep semantic colors scoped to actual semantic meaning, not decoration.

## Typography

- Major page and section headings use serif typography.
- Utility labels, panel labels, and sidebar headers use compact uppercase microcopy with tracking.
- Common label pattern: `text-[11px] font-semibold uppercase tracking-[0.18em]`.
- Body reading text should remain calm and legible, usually `text-sm` or `text-base` with generous leading.
- Avoid shouting with too many uppercase labels in a single block.

## Rounding And Shape Language

- Use rounded shapes consistently but with restraint.
- Common radii in the codebase:
  - `rounded-full` for pills, toggles, icon buttons, compact badges
  - `rounded-lg` for utility buttons and compact structural controls
  - `rounded-xl` for inner cards, inputs, attachment blocks, and grouped content
  - `rounded-2xl` or `rounded-[2rem]` for major standalone panels and large chat shells
- Do not nest multiple large rounded cards unless the inner one is a truly separate object.

## Surfaces, Borders, And Shadows

### Main Content Sections

- Prefer section separation with top borders and spacing before adding another card.
- Typical section separator:
  - Light: `border-t border-gray-300`
  - Dark: `dark:border-zinc-600`
- If a screen already lives inside the reader shell, avoid wrapping every subsection in a bordered card.

### Cards

- A card is appropriate for:
  - attachment editors
  - chat shells
  - popup panels
  - grouped tool panels with distinct behavior
- A card is usually not appropriate for:
  - each subsection of a reading page
  - every nested row in a sidebar
  - content that already has a page-level container and clear separators

### Shadows

- Heavy shadows are for elevated/floating surfaces.
- Main reading content should stay visually lighter and flatter.
- If a surface is not meant to float above the rest of the UI, prefer `shadow-sm` or no shadow.

## Button Patterns

### Primary Actions

- Primary actions usually use a filled high-contrast pill.
- Standard pattern:
  - Light: `bg-stone-900 text-white`
  - Dark: `dark:bg-stone-100 dark:text-stone-900`
- Hover should adjust tone, not change the button category.

### Secondary Actions

- Secondary actions are neutral outlined or lightly filled pills.
- Common pattern:
  - Light: `border-gray-200 bg-white` or `bg-gray-50/80`
  - Dark: `dark:border-zinc-600/50 dark:bg-zinc-700/80` or `dark:bg-stone-700`
- Keep them visually lighter than the primary button.

### Icon Buttons

- Use compact icon-only controls when the action is obvious from context.
- Destructive remove actions in attachment headers should usually be an icon-only red button, not a centered text label.
- Add `title` for clarity and accessibility.

## Badges, Pills, And Small Meta UI

- Neutral metadata pills should read as subtle overlays, not dark blobs.
- For metadata that should feel like popup-adjacent UI:
  - Light: `border-gray-300 bg-white text-gray-600`
  - Dark: `border-zinc-500/80 bg-zinc-700/60 text-zinc-200`
- Avoid making small metadata badges darker than the surface they sit on.
- Semantic pills can use red, amber, or emerald when the content truly carries that meaning.

## Forms And Inputs

- Inputs are generally soft, neutral, and slightly inset.
- Common input pattern:
  - Light: `border-gray-200 bg-gray-50`
  - Dark: `dark:border-zinc-700 dark:bg-zinc-950` or `dark:bg-stone-800`
- Focus states should tighten contrast, not add loud color.
- Prefer one clear primary action near the input group rather than several equally strong controls.

## Markdown And Rich Text

- Reuse the shared `MarkdownRenderer` for all markdown content.
- The renderer should preserve single newlines for authoring comfort; do not rely on authors remembering Markdown hard-break spacing hacks.
- Reader-facing prose should keep serif headings and neutral body copy consistent with the lesson renderer.

## Interaction And Motion

- Use short neutral transitions on hover, focus, and expand/collapse states.
- Animated emphasis should be sparse and meaningful, for example loading, pending generation, or contextual streaming.
- Avoid motion that makes reading surfaces feel unstable.

## Conventions By Surface Type

### Reader And Laboratory Pages

- Single centered reading flow.
- Section rhythm through spacing and separators.
- No dashboard-like sidebars unless there is a durable navigation or utility need.

### Sidebar Navigation

- Minimal rows, neutral hover states, clear active text contrast.
- Left rails for nested content.
- No decorative inner cards for normal navigation items.

### Chat UI

- Chat shells can use large rounded panels.
- Assistant bubbles are light neutral surfaces with borders.
- User bubbles are filled high-contrast `stone` pills.
- Tool strips, pending states, and attachment chips should remain neutral unless semantically flagged.

### Popups

- Use stronger elevation, clearer border definition, and tighter internal grouping.
- Popup styling can be richer than reader-page styling, but it still needs to stay within the gray/zinc/stone family.

## Anti-Patterns To Avoid

- Do not add a card around a section that is already inside a page-level reading container.
- Do not use a detached right sidebar for content that should be read in flow with the exercise or lesson.
- Do not create double-card hierarchies with almost identical border, radius, and shadow values.
- Do not use low-contrast dark badges on dark backgrounds.
- Do not drift into amber-tinted panels unless the content is actually a warning or an intentional accent state.
- Do not center a destructive text button inside headers when a compact top-right trash icon communicates the action better.

## Practical Checklist For Future UI Work

Before shipping a frontend UI change, verify:

- Does this screen match the existing surface type: reader, sidebar, chat, or popup?
- Am I using the neutral gray/zinc base palette by default?
- Is any `stone`, `amber`, `red`, or `emerald` usage semantically justified?
- Could this section be separated by spacing and a border instead of another card?
- Is the reading flow still clear on desktop and mobile?
- Are icon-only actions obvious and aligned with nearby content?
- Does metadata have enough contrast in both light and dark mode?
- Am I reusing the shared markdown and existing button patterns instead of creating a new local variant?
