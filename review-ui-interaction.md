# UI, Interaction & Data Review — Lumina Reader

Review date: 2026-04-28  
Scope: `apps/backend/src/**/*.ts` and `apps/web/**/*.{ts,tsx}` (excluding tests)

---

## Category 1: Event Handling and Re-rendering

### Finding 1 (MEDIUM) — Multi-setter preference hydration causes cascading re-renders

**File:** `apps/web/hooks/workspace/useWorkspaceReaderRuntime.ts` — lines ~88–129

The `applyUiPreferences` callback, used to restore persisted UI preferences on app load, calls up to 6 independent state setters in sequence:

```ts
readerChrome.setIsDarkMode(preferences.isDarkMode);
ttsPlayer.handleVoiceChange(preferences.preferredVoice);
ttsPlayer.handleVoiceChange(preferences.preferredTtsVoice);
ttsPlayer.handleModelChange(preferences.preferredTtsModel);
ttsPlayer.handleSpeedChange(preferences.playbackRate);
setSettingsPanelExpandedSections(preferences.settingsPanelExpandedSections);
setPreferredModels(/* … */);
```

Each setter triggers its own React state update and a re-render. During hydration there is no value-guard (e.g. `if (currentValue !== newValue)`), so even when the persisted preference already matches the current state the setter still fires and produces a render cycle. While React 18 batches these inside the same synchronous callback, the number of state transitions still produces unnecessary work on the first meaningful render.

**Recommendation:** Collect all preference diffs into a single batched update, or add value-guards inside each setter so a no-op state transition is returned unchanged (React bail-out).

---

### Finding 2 (MEDIUM) — Large inline props object in App.tsx rebuilt on every render

**File:** `apps/web/App.tsx` — lines ~350–460

The `readerShellProps` object passed to `<WorkspaceReaderShell>` is constructed inline every render with deeply nested sub-objects (`audioPlayer`, `banners`, `content`, `header`, `overlays`, `sidebar`). Each sub-object contains up to 30+ properties, many of which are closures that change identity every render (e.g., `onPlayPause: readerRuntime.ttsPlayer.togglePlayPause`). Although `WorkspaceReaderShell` is not wrapped in `React.memo`, the size and depth of this props object means that every state change in `App` triggers a full tree re-render — including re-creation of all the callback closures which further invalidates children.

**Recommendation:** Extract stable sub-objects (e.g., `audioPlayer`, `banners`) into their own `useMemo` blocks. Memoize `WorkspaceReaderShell` once the sub-props are stabilized.

---

### Finding 3 (MEDIUM) — Redundant ref assignment in ContextAnswerPanel

**File:** `apps/web/components/workspace/shell/ContextAnswerPanel.tsx` — lines ~163–210

`latestRequestStateRef.current` is assigned the same object twice — once at declaration and once immediately afterward in a separate block:

```ts
const latestRequestStateRef = useRef({…});
// … assignment at line ~163 …

latestRequestStateRef.current = {
  // same exact object
};
```

The second assignment is dead code and adds a needless write on every render.

**Recommendation:** Remove the duplicate assignment block.

---

### Finding 4 (SMALL) — Double scroll-reset in WorkspaceReaderShell

**File:** `apps/web/components/workspace/WorkspaceReaderShell.tsx` — lines 37–60

The second `useLayoutEffect` calls `resetScrollPosition()` twice — once synchronously and again inside `requestAnimationFrame`. The comment rationale is not present, and the double call is an anti-pattern that may paper over a browser-specific scroll timing issue.

**Recommendation:** Document the reason or remove the duplicate call if it's vestigial.

---

### Finding 5 (SMALL) — Reader context handlers recreated on viewport change

**File:** `apps/web/hooks/reader/useReaderContext.ts` — lines ~237–261

`handleContentContextMenu`, `handleContentPointerDownCapture`, and `handleContentClick` all depend on `isMobileViewport` in their closure. Since `isMobileViewport` changes when the window crosses the 1024px breakpoint (a rare event), the handlers are effectively stable most of the time — but the `useCallback` dependency on `isMobileViewport` means they are recreated on resize, which cascades to their consumers (`onContentContextMenu`, `onContentPointerDownCapture`, `onContentClick` props).

**Recommendation:** Move the `isMobileViewport` guard inside the handler via a ref instead of listing it as a dependency. This keeps handler identity stable across all renders.

---

## Category 2: Data Ordering and Stability

### Finding 6 (MEDIUM) — SQLite read queries lack ORDER BY

**File:** `apps/backend/src/projects/sqliteProjectStore.ts` — private methods

The private `readProjectMetas`, `readFolders`, and `readPlacements` methods query SQLite without `ORDER BY`:

```sql
select meta_json from projects where user_id = ?
select folder_json from library_folders where user_id = ?
select placement_json from library_placements where user_id = ?
```

The public methods `listProjects`, `listFolders`, and `listPlacements` sort the results afterward in JavaScript, so this is not currently a visible bug. However, the private `readFolders` and `readPlacements` are consumed by `buildOrderedSiblingItems`, `getNextFolderOrder`, `resolveNextPlacementOrder`, `moveFolder`, `moveProjects`, etc. — all of which rely on consistent iteration. SQLite row order without `ORDER BY` is undefined; while it happens to be insertion-order in practice, this is an implementation detail that could change.

**Recommendation:** Add `ORDER BY order_index ASC` to the folder and placement read queries, and `ORDER BY updated_at DESC` to the project metas read query.

---

### Finding 7 (SMALL) — Sidebar group ordering relies on Map insertion order

**File:** `apps/web/utils/reader/workspaceReader.ts` — `buildSidebarGroups()` (lines ~30–120)

The `groupOrder` array starts with syllabus module IDs and fallback group keys are pushed afterward. Grouped sections are stored in a `Map<string, LearningSection[]>` and iterated via `groupOrder.map()`. This is correct per ES2015 spec (Map preserves insertion order), and the fallback keys are consistently ordered. No bug, but the reliance on implicit Map ordering is worth a comment.

**Recommendation:** Add a brief comment noting that Map insertion order is relied upon for group ordering.

---

### Finding 8 (SMALL) — Annotations sorted by document position, stable

**File:** `apps/web/utils/learning/sectionAnnotations.ts` — `sortAnnotationsByDocumentOrder` (~line 780)

Annotation sorting is handled correctly: by position in document content, then by `createdAt` as tiebreaker. No issue — documented for completeness.

---

## Category 3: UI and Interaction Design

### Finding 9 (MEDIUM) — Attachment submenu placement logic uses `||` instead of `&&`

**File:** `apps/web/components/library/HomeChatPanel.tsx` — lines ~145–155

The submenu side decision:

```ts
setAttachmentSubmenuSide(spaceOnRight >= 344 || spaceOnRight >= spaceOnLeft ? 'right' : 'left');
```

The `||` means the submenu opens to the right whenever there are at least 344px on the right, regardless of how much more space exists on the left. When `spaceOnRight` is, say, 200px but `spaceOnLeft` is 500px, the condition `spaceOnRight >= spaceOnLeft` is false, but `spaceOnRight >= 344` is also false, so it picks 'left' — that case works. But when `spaceOnRight` is exactly 344px (barely enough) and `spaceOnLeft` is 600px, it still picks 'right'. The intent was likely `&&` (pick right only when it has both enough room AND more room than the left).

**Recommendation:** Change `||` to `&&`:
```ts
setAttachmentSubmenuSide(spaceOnRight >= 344 && spaceOnRight >= spaceOnLeft ? 'right' : 'left');
```

---

### Finding 10 (SMALL) — Estimated menu heights are magic numbers

**Files:**
- `apps/web/components/library/ProjectCard.tsx` — `MENU_ESTIMATED_HEIGHT = 188`, `MENU_WIDTH = 176`
- `apps/web/components/library/LibraryTreeView.tsx` — `estimatedMenuHeight = projectRepositoryMode === 'indexeddb' ? 272 : 230`
- `apps/web/components/workspace/shell/WorkspaceReaderSidebar.tsx` — `LAB_CONTEXT_MENU_WIDTH = 272`, `LAB_CONTEXT_MENU_HEIGHT = 132`, `LESSON_CONTEXT_MENU_WIDTH = 272`, `LESSON_CONTEXT_MENU_HEIGHT = 120`

These hardcoded pixel values are scattered across components and used for flip-above/below calculations. Adding or removing a menu item silently changes the actual height, breaking the flip logic without warning.

**Recommendation:** Derive menu height from the actual DOM (e.g., measure `scrollHeight` after render) or at least make the hardcoded value a function of the number of visible items. Centralize menu dimension constants.

---

### Finding 11 (GOOD) — Motion tokens are centralized

**File:** `apps/web/utils/motion/tokens.ts`

All animation durations, easings, spring configs, and variants are defined in a single file. This is excellent practice and should be maintained.

---

### Finding 12 (GOOD) — Dark/light mode handled consistently with Tailwind

All color decisions flow through Tailwind `dark:` variants. No hardcoded hex colors were found outside of Tailwind classes in the JSX. The `motion/tokens.ts` file uses named easing curves; the `MarkdownRenderer` uses `oneDark` / `oneLight` prism themes. Consistent.

---

### Finding 13 (SMALL) — No success toasts for obvious actions

The codebase avoids showing "Saved!", "Copied!", or similar success messages for routine actions. The only notification shown is for errors and the journey-complete milestone. Good UX.

---

## Category 4: Localization and User-Facing Text

### Finding 14 (MEDIUM) — Backend error messages are in English; frontend is in Italian

The frontend (components, system prompts, `chatPrompts.ts`) is consistently in Italian. However, backend route handlers return English error strings:

| File | Example |
|------|---------|
| `apps/backend/src/routes/contextChat.ts:276` | `'Missing selectedText for contextual chat.'` |
| `apps/backend/src/routes/contextChat.ts:292` | `'Failed to stream contextual chat response'` |
| `apps/backend/src/routes/libraryChat.ts:285` | `'Missing chat messages for library chat.'` |
| `apps/backend/src/routes/pdf.ts:35` | `'A PDF data URL is required.'` |
| `apps/backend/src/routes/pdf.ts:59` | `'Failed to extract text from PDF.'` |
| `apps/backend/src/routes/tts.ts:47` | `'Failed to get TTS models'` |
| `apps/backend/src/routes/tts.ts:79` | `'Failed to generate speech'` |
| `apps/backend/src/routes/projects.ts:50` | `'Failed to read project sync config'` |
| `apps/backend/src/routes/projects.ts:61` | `'Failed to list projects'` |
| `apps/backend/src/auth/currentUser.ts:23` | `'Authentication is not configured for this deployment.'` |

Meanwhile, `httpProjectRepository.ts` and `chatPrompts.ts` use Italian consistently. This creates a situation where an API-level error surfaced to the user will appear in English in an otherwise Italian UI.

**Recommendation:** Either translate backend error strings to Italian to match the frontend convention, or add a client-side error-message mapping layer.

---

### Finding 15 (SMALL) — Debug logging mixes languages

**File:** `apps/web/components/workspace/shell/WorkspaceReaderSidebar.tsx` — line ~163

```ts
console.error('[Nous][Debug] Failed to copy lesson markdown.', error);
```

Other debug traces use Italian (`pushNousDebugTrace` messages in `projectLifecycle.ts` use English keys like `'open-project:library-refreshed'`). The debug logs are not user-facing, so this is low-impact, but inconsistency adds friction during debugging.

**Recommendation:** Pick one language for all internal logging prefixes.

---

### Finding 16 (SMALL) — No centralized string management

Error messages and UI strings are defined inline throughout the codebase. While the project is consistent in using Italian for user-facing strings, there is no single source of truth for error messages. This makes it difficult to ensure consistency, audit for localization coverage, or switch languages in the future.

**Recommendation:** Consider extracting user-facing strings into a shared constants module (e.g., `apps/web/constants.ts` or a dedicated `strings.ts`).

---

### Finding 17 (GOOD) — System prompts are consistently Italian

**File:** `apps/backend/src/routes/chatPrompts.ts` (entire file)

All system prompts (`buildContextSystemPrompt`, `buildLibrarySystemPrompt`, `buildContextWebSearchMandate`, etc.) are written in Italian, matching the frontend language convention. The prompts are long but well-structured and maintain consistent terminology.

---

## Summary

| Severity | Count | Key Issues |
|----------|-------|------------|
| **SEVERE** | 0 | No data corruption, UI bugs, or jitter found |
| **MEDIUM** | 7 | Cascading re-renders during preference hydration (F1), large inline props object (F2), redundant ref assignment (F3), SQLite queries lack ORDER BY (F6), submenu placement logic bug (F9), backend English error messages (F14) |
| **SMALL** | 7 | Double scroll reset (F4), handler recreation on viewport change (F5), Map ordering reliance uncommented (F7), hardcoded menu dimensions (F10), mixed debug log languages (F15), no centralized strings (F16) |

### Overall Assessment

The codebase is well-architected with careful attention to data ordering (annotations, library tree, sidebar groups all sorted properly). Animation tokens are centralized. Dark/light mode is handled consistently through Tailwind. The main areas for improvement are: (1) the preference hydration flow triggers avoidable re-renders, (2) backend error messages should be translated to Italian for consistency, and (3) the attachment submenu placement logic has a probable `||` vs `&&` bug.
