# Code Structure & Quality Review — Lumina-Reader

## SEVERE Findings

### S1. Massive Code Duplication Between `planning.ts` and `planGeneration.ts`

**Files:**
- `apps/web/services/openrouter/planning.ts` (lines ~150–420)
- `apps/web/services/openrouter/planGeneration.ts` (lines ~35–350)

**Description:** These two files contain near-identical copies of a large block of domain logic:
- `PlanningSourceProfile` interface and its seed variant
- `resolvePdfSourceSizeTier()`, `resolveTextSourceSizeTier()`
- `resolvePlanningSourceProfileFromSeed()` and `resolvePlanningSourceProfile()`
- `buildAdaptivePlanGuidance()`, `buildPdfPlanCoverageGuidance()`, `formatPlanningCountRange()`, `formatPlanningSourceStats()`
- `dedupeLearningPlanSections()` and all its helper functions (`normalizeSearchText`, `getSearchKeywords`, `isPlanSectionNearDuplicate`, etc.)
- `LessonVerificationDraft`, `SoftTimeoutError`, `withSoftTimeout`
- `PDF_KEYWORD_STOP_WORDS`, `PDF_SUBSTANTIVE_PAGE_COVERAGE_RATIO`, threshold constants

These ~270 lines of duplicate code will diverge over time, causing subtle bugs. Extract the shared logic into a single module (e.g., `planSourceProfile.ts` or `sharedPlanUtils.ts`) and import from both files.

---

### S2. Monolithic `App.tsx` Component (800+ lines)

**File:** `apps/web/App.tsx`

**Description:** The root `App` component mixes too many distinct concerns:
- Screen routing (library / assessment / planning / reading) with inline JSX construction
- Notification management (toast with auto-dismiss)
- Confirmation dialog portal rendering
- Auto-open lesson logic with refs, `useEffect` chains, and dialog gating
- `readerShellProps` assembly (~250 lines constructing a deeply nested object spanning audio, banners, content, header, overlays, sidebar)
- Assessment orchestration (`handleNewCourseMessage`, `handleConfirmGenerate`)
- Lab exercise stats computation
- File upload wiring
- Model defaults and PDF mapping warning resolution
- Keyboard shortcut–adjacent behaviors

**Impact:** Modifying any single screen or UI behavior requires parsing the entire file. Cognitive complexity is very high. The `readerShellProps` object alone is a coupling point between 6+ independent subsystems.

**Recommendation:** Split screen construction into separate layout components (`LibraryScreen`, `AssessmentScreen`, `ReadingScreen`). Extract `useAppNotifications`, `useConfirmationDialog`, and `useAutoOpenLesson` into dedicated hooks. Move `readerShellProps` assembly into `useReadingScreenProps`.

---

### S3. Duplicate `createProjectId` / `createFolderId` in Multiple Files

**Files:**
- `apps/backend/src/projects/projectMeta.ts` (line ~17)
- `apps/backend/src/projects/sqliteProjectStore.ts` (line ~47)

**Description:** Both `projectMeta.ts` and `sqliteProjectStore.ts` define a `createProjectId()`/`createFolderId()` function with identical fallback logic (UUID → timestamp+random). This is copy-pasted code. If the generation strategy changes, one copy will be missed.

**Recommendation:** Extract to a shared `idGenerators.ts` in the projects folder.

---

### S4. Near-Identical Web Search Mandate Strings

**File:** `apps/backend/src/routes/chatPrompts.ts` (lines ~195–235)

**Description:** `buildContextWebSearchMandate()` and `buildLibraryWebSearchMandate()` are ~90% identical. The only difference is a subtle phrasing change in the "not active" branch (`"rafforza"` vs `"non vieta il tool"`). Two ~18-line template strings are repeated.

**Recommendation:** Extract a shared `buildWebSearchMandate(active: boolean, variant: 'context' | 'library')` helper.

---

## MEDIUM Findings

### M1. Giant `sectionAnnotations.ts` (1155 lines)

**File:** `apps/web/utils/learning/sectionAnnotations.ts`

**Description:** This file handles four distinct responsibilities:
1. **Text projection/visible content extraction** (`buildVisibleProjection`, `buildLooseProjection`, `buildSourceLooseProjection`, ~200 lines)
2. **Text search/matching** (`resolveExactMatch`, `resolveSelectedSegments`, ~150 lines)
3. **Mark segment parsing and annotation groups** (`parseMarkSegments`, `buildGroupsById`, `groupLegacySegmentsByContent`, ~100 lines)
4. **Annotation CRUD operations** (`applySectionAnnotation`, `removeSectionAnnotation`, `updateSectionAnnotationNote`, `migrateSectionAnnotations`, ~400 lines)

**Impact:** Finding any one function requires scrolling through unrelated logic. High cognitive load.

**Recommendation:** Split into at least two files: `annotationProjection.ts` (projection + matching + mark segment parsing) and `annotationOperations.ts` (apply/remove/update/migrate).

---

### M2. `render.ts` at ~490 Lines with Complex Inline Sub-functions

**File:** `apps/web/utils/markdown/render.ts`

**Description:** The `normalizeMarkdownForRendering()` function orchestrates a pipeline of 12+ transformation stages, many with inline regex constants and helper functions defined at module scope (e.g., `processMarkdownSegment`, `sanitizeMixedFencedCodeBlock`, `mergeSplitTextPseudocodeBlocks`, `mergeSplitBraceFencedBlocks`). The cognitive complexity is well above 15, particularly in `processMarkdownSegment` which handles inline math, code fences, orphaned continuations, and HTML escaping in a single loop.

**Recommendation:** Extract each transformation stage into a named function in a `markdownTransforms.ts` file, making the pipeline readable as a composition.

---

### M3. `sqliteProjectStore.ts` Move Operation Complexity

**File:** `apps/backend/src/projects/sqliteProjectStore.ts` (lines ~180–310)

**Description:** Both `moveFolder` and `moveProjects` contain deeply nested logic: they compute source siblings, destination siblings, filtered destinations, insertion indexes, reparent, and persist orders, all inside explicit `transaction()` blocks. The same `buildOrderedSiblingItems` → `resolveInsertionIndex` → `persistSiblingOrders` pattern appears in both. This is business-logic duplication within the same file.

**Recommendation:** Extract a `reorderItems(userId, parentFolderId, items, touchedAt)` internal method shared by both move operations.

---

### M4. `DEFAULT_TTS_MODEL` Defined in Two Places

**Files:**
- `apps/backend/src/services/ttsClient.ts` (line ~20)
- `apps/web/services/audio/voiceProfile.ts` (line ~8)

**Description:** The same default TTS model string `'openai/gpt-4o-mini-tts-2025-12-15'` is hardcoded in both backend and web. There is no shared source of truth.

**Recommendation:** Either have the web fetch the default from the backend `/api/tts/models` endpoint, or extract to a shared config package.

---

### M5. `TtsModelSummary` Interface Duplicated Between Backend and Web

**Files:**
- `apps/backend/src/types/index.ts` (line ~40)
- `apps/web/types.ts` (line ~256)
- Re-exported in `apps/web/services/openrouter/types.ts` (line ~56)

**Description:** The same interface is defined three times. Any field change must be synchronized manually.

**Recommendation:** Use a shared types package (e.g., `@lumina/shared-types`) or have the web infer types from API responses.

---

### M6. `useWorkspaceControllerState` — Manual Ref Synchronization

**File:** `apps/web/hooks/workspace/controller/state.ts`

**Description:** The hook maintains three `useRef` mirrors of `useState` values (`assessmentMessagesRef`, `chatSessionRef`, `workflowStateRef`) and synchronizes them via `useEffect`. This is a pattern that React's `useRef` + `useState` pairing should avoid — it's fragile and verbose. Each state variable has both a `useState` and a mirrored `useRef` with a dedicated `useEffect`.

**Recommendation:** Consider using `useReducer` for the workflow state, which naturally gives you a single source of truth and a way to read current state in callbacks without refs. Or use `useSyncExternalStore` for the adapter pattern.

---

### M7. Missing JSDoc on Public API Functions

**Files (sampling):**
- `apps/web/services/openrouter/planning.ts` — `generateSectionContent`, `createSubChapterMetadata`, `createLearnSubChapterMetadata` have no JSDoc
- `apps/web/services/openrouter/assessment.ts` — `createAssessmentChat`, `createEmbeddedAssessmentChat` have no JSDoc
- `apps/web/services/openrouter/laboratory.ts` — `generateLaboratory`, `evaluateLaboratoryExercise` have no JSDoc
- `apps/backend/src/services/pdfImageExtractor.ts` — `extractPdfImages` has no JSDoc describing the threshold algorithm, dedup strategy, or the context extraction approach

**Description:** These are public-facing API functions with non-obvious behaviors (PDF image filtering with complex dimension thresholds, chat session lifecycle, lesson dedup algorithms). Lack of documentation makes onboarding difficult.

**Recommendation:** Add JSDoc with `@param`, `@returns`, and a brief description of the algorithm/contract for each exported function.

---

### M8. Config Object Creep in `buildContextSystemPrompt`

**File:** `apps/backend/src/routes/chatPrompts.ts` (lines ~303–380)

**Description:** `buildContextSystemPrompt` accepts 18 parameters as a destructured object (which is good), but the body interleaves template string construction with conditional logic, making it hard to tell which parameters produce which prompt sections. The function is ~80 lines long.

**Recommendation:** Break into sub-functions: `buildSelectionContextSection()`, `buildAnnotationSection()`, `buildToolRulesSection()`.

---

## SMALL Findings

### SM1. One-Line Pass-Through in `services/openrouter/retry.ts`

**File:** `apps/web/services/openrouter/retry.ts` (line ~5)

```ts
export { getErrorMessage };
```

**Description:** This simply re-exports `getErrorMessage` from `../core/errorMessage.ts`. This is a thin pass-through wrapper with no added value — it just adds indirection. Consumers should import directly from `core/errorMessage.ts`.

---

### SM2. Stale/Redundant Comment in `App.tsx`

**File:** `apps/web/App.tsx` (line ~405)

```ts
// Anteprima dell'UI di caricamento per il debug (aggiungi #preview-loading all'URL)
```

**Description:** This comment describes a debug-only view that is accessed via URL hash. Debug functionality in production code should be gated by `import.meta.env.DEV` or extracted entirely.

---

### SM3. Unused `OPENROUTER_BASE_URL` Export in `ttsClient.ts`

**File:** `apps/backend/src/services/ttsClient.ts` (line ~17)

```ts
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
```

**Description:** This constant is exported but I could not find any importer of it outside the `ttsClient.ts` file itself. It's used internally; no need to export it.

---

### SM4. `toTimestamp` Truncates to Seconds — Comment Missing

**File:** `apps/backend/src/projects/sqliteProjectStore.ts` (line ~30)

```ts
const toTimestamp = (value: string | undefined): number => {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
};
```

**Description:** The name `toTimestamp` suggests a string output, but it returns a number (epoch milliseconds). The comparison `toTimestamp(right.lastOpenedAt) - toTimestamp(left.lastOpenedAt)` works, but a brief comment explaining the numeric sort key intent would help.

---

### SM5. Unused Parameter Prefix Convention Inconsistent

**Files:** Multiple (e.g., `apps/backend/src/index.ts`, `apps/web/services/workspace/workflow.ts`)

**Description:** Some files use `_unused` prefix (e.g., `_req`, `_error`, `_snapshot`), while others use just `_` for unused parameters. This is inconsistent within the project. Pick one convention.

---

### SM6. `genericLibraryToolOutputSchema` — Lax Typing

**File:** `apps/backend/src/routes/libraryChat.ts` (line ~80)

```ts
const genericLibraryToolOutputSchema = jsonSchema<Record<string, unknown>>({
  type: 'object',
  additionalProperties: true,
  properties: { error: { type: 'string' } },
});
```

**Description:** All library assistant tools use `additionalProperties: true` as their output schema, meaning any shape passes validation. This defeats the purpose of structured output. Each tool should have its own output schema matching what `toolExecutor.ts` actually returns.

---

### SM7. `buildPdfReasoningExtractionNotes` is Duplicated

**Files:**
- `apps/web/services/openrouter/planning.ts` (lines ~317-350)
- `apps/web/services/openrouter/contextChat.ts` (lines ~13-40)

**Description:** Same function exported from both files. `planning.ts` actually imports it from `contextChat.ts` but also re-exports it. The import in `planning.ts`'s own barrel re-export is the correct approach, but `planGeneration.ts` imports it from `./contextChat.ts` while `planning.ts` has the same code. Ensure all consumers import from a single source.

---

### SM8. Commented-Out / Intentional Empty Catch Blocks Without Explanation

**File:** `apps/web/services/openrouter/json.ts` (lines ~110, ~150)

```ts
} catch {
  // intentional: fallback to default
  return fallback;
}
```

**Description:** Multiple empty catch blocks use the comment `// intentional: fallback to default`. While the intent is noted, a brief explanation of *why* the fallback is safe (e.g., "model may return malformed JSON on first attempt") would make the code more maintainable.

---

### SM9. Inline CSS Constants in `readerChrome.ts`

**File:** `apps/web/hooks/reader/useReaderChrome.ts` (lines ~6–8)

```ts
const SIDEBAR_WIDTH_PX = 384;
const MOBILE_LAYOUT_BREAKPOINT_PX = 1024;
const MOBILE_LAYOUT_MEDIA_QUERY = `(max-width: ${MOBILE_LAYOUT_BREAKPOINT_PX - 1}px)`;
```

**Description:** These layout constants are coupled to CSS. If the CSS breakpoint changes, this file must also change. Consider reading these from CSS custom properties or defining them in a shared constants/design-tokens file.

---

### SM10. `formatProjectList` Uses Accidental Complexity for Pluralization

**File:** `apps/web/services/library/toolExecutor.ts` (lines ~48–72)

**Description:** The function manually constructs Italian plural messages (`"1 corso non riconosciuto"` vs `"${n} corsi non riconosciuti"`) with inline conditionals. A small `pluralize` helper would reduce the character-counting and nested ternaries.

---

## Summary Table

| ID | Severity | Category | Location | Issue |
|----|----------|----------|----------|-------|
| S1 | SEVERE | Dead Code / Duplication | `planning.ts` + `planGeneration.ts` | ~270 lines of duplicate plan-building logic |
| S2 | SEVERE | Modularity / Complexity | `App.tsx` | 800+ line monolithic component |
| S3 | SEVERE | Duplication | `projectMeta.ts` + `sqliteProjectStore.ts` | Duplicate ID generation functions |
| S4 | SEVERE | Duplication | `chatPrompts.ts` | Nearly identical web search mandate strings |
| M1 | MEDIUM | File Organization | `sectionAnnotations.ts` | 1155-line file mixing projection + matching + CRUD |
| M2 | MEDIUM | Complexity | `render.ts` | 490 lines of markdown normalization with high cognitive complexity |
| M3 | MEDIUM | Helper Design / Duplication | `sqliteProjectStore.ts` | Duplicated move logic between `moveFolder` and `moveProjects` |
| M4 | MEDIUM | Duplication | `ttsClient.ts` + `voiceProfile.ts` | `DEFAULT_TTS_MODEL` defined twice |
| M5 | MEDIUM | Duplication | `types/index.ts` (backend + web) | `TtsModelSummary` interface defined 3 times |
| M6 | MEDIUM | Complexity | `controller/state.ts` | Manual ref/state sync pattern |
| M7 | MEDIUM | Documentation | Multiple openrouter files | No JSDoc on public API functions |
| M8 | MEDIUM | Complexity | `chatPrompts.ts` | 80-line prompt builder with interleaved template + logic |
| SM1 | SMALL | Helper Design | `retry.ts` | One-line re-export wrapper |
| SM2 | SMALL | Dead Code / Comments | `App.tsx` | Debug-only view with hash-based gating |
| SM3 | SMALL | Cleanup | `ttsClient.ts` | Unnecessary export of `OPENROUTER_BASE_URL` |
| SM4 | SMALL | Naming / Comments | `sqliteProjectStore.ts` | `toTimestamp` name misleading |
| SM5 | SMALL | Style | Multiple | Inconsistent unused-parameter prefix convention |
| SM6 | SMALL | Helper Design | `libraryChat.ts` | Lax `additionalProperties: true` in output schemas |
| SM7 | SMALL | Duplication | `planning.ts` + `contextChat.ts` | `buildPdfReasoningExtractionNotes` duplicated |
| SM8 | SMALL | Comments | `json.ts` | Empty catch blocks missing "why" explanation |
| SM9 | SMALL | Modularity | `useReaderChrome.ts` | Layout constants coupled across hook/CSS |
| SM10 | SMALL | Helper Design | `toolExecutor.ts` | Manual pluralization without helper |
