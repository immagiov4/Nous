# Code Review: Consistency & Standards — Lumina-Reader

**Date:** 2026-04-28  
**Scope:** All `.ts` / `.tsx` source files (excluding tests) in `apps/backend/src/` and `apps/web/`

---

## Category 1: Single Source of Truth — Duplicated Constants, Logic, Types

### SEVERE FINDINGS

---

#### S1. Duplicated project identity logic between backend and frontend

**Files:**
- `apps/backend/src/projects/projectMeta.ts` (lines 3, 11–18, 91–133)
- `apps/web/services/projects/projectSnapshot.ts` (lines 785, 832–840, 880–1032)

**Details:** The following are duplicated verbatim or near-verbatim:

| Item | Backend | Frontend |
|------|---------|----------|
| `DEFAULT_PROJECT_VERSION` / `CURRENT_PROJECT_VERSION` = `'4.1'` | `projectMeta.ts:3` | `projectSnapshot.ts:25` |
| `createProjectId()` function | `projectMeta.ts:11–18` | `projectSnapshot.ts:32–38` |
| `inferProjectSourceKind()` function | `projectMeta.ts:29–48` | `projectSnapshot.ts:40–60` |
| `getProjectTitle()` function | `projectMeta.ts:50–82` | `projectSnapshot.ts:62–92` |
| `buildCoverLabel()` function | `projectMeta.ts:84–111` | `projectSnapshot.ts:94–118` |
| `buildProjectMeta()` function | `projectMeta.ts:113–133` | `projectSnapshot.ts:120–138` |
| `exportProjectData()` function | `projectMeta.ts:135–137` | `projectSnapshot.ts:1066–1082` |
| `ensureString()`, `isRecord()` helpers | `projectMeta.ts:5–8, 20–21` | `projectSnapshot.ts:27–30` |

**Risk:** The backend's `SqliteProjectStore.saveProject` calls `normalizeProjectSnapshot` + `buildProjectMeta` (server-side), while the web client also has its own `buildProjectMeta` and `normalizeStoredProject`. If the logic drifts between the two copies (e.g., someone updates the cover label format in the backend but not the frontend), the library display will show stale/inconsistent metadata while the stored meta is correct. This is a persistent source of fragility across every project save/load cycle.

**Recommendation:** Extract shared project identity logic into a shared package or ensure the frontend calls the backend API for metadata generation exclusively.

---

#### S2. Massive duplication between `planGeneration.ts` and `planning.ts`

**Files:**
- `apps/web/services/openrouter/planning.ts` (lines 41–150, 153–329, 331–478, and many more)
- `apps/web/services/openrouter/planGeneration.ts` (substantial duplicate contents)

**Details:** `planGeneration.ts` is effectively a superset of `planning.ts` plus additional lesson generation logic. The following are duplicated identically:

- `PDF_KEYWORD_STOP_WORDS` Set (~80 stop words) — `planning.ts:19–105`, `planGeneration.ts:48–119`
- `resolvePlanningSourceProfileFromSeed()` — `planning.ts:106–150`, `planGeneration.ts:120–164`
- `buildAdaptivePlanGuidance()` — `planning.ts:153–265`, `planGeneration.ts:167–279`
- `dedupeLearningPlanSections()` — `planning.ts:331–382`, `planGeneration.ts:345–396`
- `normalizeSearchText()` — `planning.ts:140–146`, `planGeneration.ts:164–170`
- `getSearchKeywords()` — `planning.ts:148–152`, `planGeneration.ts:172–176`
- `clipPdfSourceText()` — `contextChat.ts:7–13`, `planning.ts:392–398`, `planGeneration.ts:1608–1614`
- `buildPdfReasoningExtractionNotes()` — `contextChat.ts:15–38` (web), `planning.ts:400–423`, `planGeneration.ts:1616–1639`
- `buildReasoningContentForFile()` — `contextChat.ts:40–66` (web), `planning.ts:425–452`, `planGeneration.ts:1641–1668`
- All `PLAN_SECTION_*` threshold constants — both files
- `resolvePdfSourceSizeTier()`, `resolveTextSourceSizeTier()`, `formatPlanningCountRange()`, etc. — both files
- `isCompactPlanningSource()`, `buildPlanSectionScopeText()`, `computePlanKeywordOverlap()`, `isPlanSectionNearDuplicate()`, `getPlanSectionSpecificityScore()`, `pickPreferredPlanSection()` — both files

**Risk:** These files share a core planning domain model. If someone adjusts the PDF keyword stop words or the source size tiering logic in one file but forgets the other, plan generation vs. curriculum generation will produce inconsistent results. The duplicated ~300 lines of domain logic are a maintenance burden.

**Recommendation:** `planning.ts` and `planGeneration.ts` should share these utilities from a common module. `planning.ts` itself appears to be used only as a re-export source; verify if it can be eliminated entirely in favor of `planGeneration.ts`.

---

#### S3. Duplicated `OpenRouterWebSearch` logic between context and library chat routes

**Files:**
- `apps/backend/src/routes/contextChat.ts` (lines 20–77 — `runContextWebSearch`, `createContextSearchWebTool`)
- `apps/backend/src/routes/libraryChat.ts` (lines 24–90 — `runLibraryWebSearch`, `createLibrarySearchWebTool`)

**Details:** Both routes create web search tools that:
1. Build nearly identical system/user messages for the web search researcher
2. Share the same `runOpenRouterWebSearch` call signature
3. Have identical `inputSchema`/`outputSchema` definitions for the tool
4. Share the same web search mandate language (in `chatPrompts.ts`, the `buildContextWebSearchMandate` and `buildLibraryWebSearchMandate` functions are identical paragraph-for-paragraph)

The differences between `runContextWebSearch` and `runLibraryWebSearch` are trivial (different user message templates inserting context vs. library scope).

**Risk:** The web search tool schema and execution are duplicated across two route files. Changes to the tool's behavior (e.g., adjusting max results, changing the researcher system prompt) must be made in two places.

**Recommendation:** Extract a shared `createOpenRouterWebSearchTool()` factory in `chatPrompts.ts` that both routes can use.

---

#### S4. Duplicated `DEFAULT_TTS_MODEL` and voice list between backend and frontend

**Files:**
- `apps/backend/src/services/ttsClient.ts` (lines 12–13 — `DEFAULT_TTS_MODEL`, `OPENAI_TTS_VOICES` Set)
- `apps/web/services/audio/voiceProfile.ts` (lines 8–9 — `DEFAULT_TTS_MODEL`, `DEFAULT_VOICE_OPTIONS` array)

**Details:**
- `DEFAULT_TTS_MODEL = 'openai/gpt-4o-mini-tts-2025-12-15'` is hardcoded in both backend and frontend
- Backend has `OPENAI_TTS_VOICES` (a `Set<string>`), frontend has `DEFAULT_VOICE_OPTIONS` (an array of `VoiceOption` objects) — same voices, different data structures

**Risk:** If the TTS model is upgraded, it must be changed in two places. Voice list drifts risk showing incorrect available voices in the UI.

**Recommendation:** The backend should be the single source of truth for TTS configuration. The frontend should fetch voices from `/api/voices` rather than maintaining a duplicate static list.

---

#### S5. Duplicated `'sync-ready'` string literal across codebase

**Files:** Multiple locations

**Details:** The string `'sync-ready'` (a `ProjectSyncState` value) is used as a bare literal in multiple places:
- `apps/backend/src/projects/projectMeta.ts:132`
- `apps/backend/src/projects/sqliteProjectStore.ts:169`
- `apps/web/services/projects/persistenceSignature.ts` (likely)
- `apps/web/types.ts` (the `ProjectSyncState` type definition)

It's defined as a type union but used as bare string literals instead of a shared constant.

**Risk:** If the sync state enum changes, all bare string references must be manually updated.

**Recommendation:** Define all `ProjectSyncState` values as named constants or use an enum.

---

### MEDIUM FINDINGS

---

#### M1. Duplicated `clip()` utility

**Files:**
- `apps/backend/src/routes/chatPrompts.ts:93–100`
- `apps/web/services/laboratory/attachments.ts:32–37`
- `apps/web/services/openrouter/laboratory.ts:208–214`

**Details:** A `clip(value, maxChars, suffix)` function appears in three separate files with nearly identical implementations. The backend version returns `'[contesto troncato]'` prefix, the frontend versions accept a custom suffix parameter.

**Recommendation:** Extract a shared `clipText()` utility used across the codebase.

---

#### M2. Duplicated `isRecord()` helper

**Files:**
- `apps/backend/src/projects/projectMeta.ts:5–6`
- `apps/backend/src/projects/sqliteProjectStore.ts` (implicit via `parseJson`)
- `apps/web/services/projects/projectSnapshot.ts:27–28`
- `apps/web/services/library/toolExecutor.ts:41–42`
- `apps/web/services/openrouter/retry.ts:8–9`
- `apps/web/services/openrouter/shared.ts` (re-export)

**Details:** The `isRecord` type guard is defined in at least 5 separate locations with identical logic.

**Recommendation:** Centralize in a shared utilities module.

---

#### M3. Duplicated `normalizeHost` and `normalizePort` functions

**Files:**
- `apps/backend/src/config/serverConfig.ts:11–19` (used for backend server config)
- `apps/web/services/openrouter/config.ts:64–73` (used for web's backend URL resolution)

**Details:** Identical functions for normalizing host/port values, used in both backend and frontend for different purposes. The port normalization logic (`parseInt`, `Number.isInteger`, fallback) is duplicated.

**Recommendation:** Keep each context's version but document why they can't be shared (they resolve from different env sources).

---

#### M4. `buildContextWebSearchMandate` and `buildLibraryWebSearchMandate` are identical

**File:** `apps/backend/src/routes/chatPrompts.ts:211–237` (lines 211–237)

**Details:** The two functions return nearly word-for-word identical prompt text — `PRIORITA WEB:` preamble with 5 bullet points. The only difference on the non-`webSearch` branch: context version says `non attiva non vieta il tool`, library version says the same thing.

These are effectively the same function with `toolPreferences?.webSearch` driving a boolean branch. Two separate exported functions create an illusion of divergence.

**Recommendation:** Merge into a single `buildWebSearchMandate(toolPreferences: { webSearch?: boolean })` function.

---

#### M5. `buildToolNarrationMandate()` is used by both context and library prompts but duplicated as inline string building

**File:** `apps/backend/src/routes/chatPrompts.ts:239–246`

The function exists and is reused. However, the same tool narration text could appear in different prompt builders — currently it's called within `buildContextSystemPrompt` and `buildLibrarySystemPrompt` inline, which is correct. No duplication found here. (Retracted — OK.)

---

### SMALL FINDINGS

---

#### S1. `PDF_DATA_URL_PREFIX` regex duplicated

**Files:**
- `apps/backend/src/services/pdfImageExtractor.ts:82`
- `apps/backend/src/services/pdfTextExtractor.ts:15`

**Details:** The regex `/^data:application\/pdf;base64,/i` is defined as a private constant in both files. It's also checked inline in `apps/backend/src/routes/pdf.ts:12` as a string `.startsWith()` check (which is functionally equivalent but a different approach).

**Recommendation:** Move to a shared PDF utilities module.

---

#### S2. `createFolderId()` duplicates `createProjectId()` logic

**File:** `apps/backend/src/projects/sqliteProjectStore.ts:59–64` and `apps/backend/src/projects/projectMeta.ts:11–18`

**Details:** `createFolderId()` and `createProjectId()` are nearly identical — both use `crypto.randomUUID()` with the same fallback pattern. The only difference is the prefix string (`'project-'` vs `'folder-'`).

**Recommendation:** Extract a shared `createUuid(prefix: string)` function.

---

#### S3. `createLaboratoryAttachmentId()` duplicates the same UUID pattern

**File:** `apps/web/services/laboratory/attachments.ts:14–18`

Same `crypto.randomUUID()` / fallback pattern.

**Recommendation:** Use `createProjectId` or a shared `randomId()` utility.

---

## Category 2: Magic Numbers & Magic Strings

### SEVERE FINDINGS

---

#### S4. `maxResults: 5` default in `runOpenRouterWebSearch`

**File:** `apps/backend/src/routes/chatPrompts.ts:148`

**Details:** In `runOpenRouterWebSearch`, the default for `maxResults` is:
```ts
Math.min(Math.max(Math.trunc(maxResults || 5), 1), 8)
```
The value `5` is a bare number. It's a default search result count that affects API cost and response quality.

**Recommendation:** Define as `DEFAULT_WEB_SEARCH_MAX_RESULTS = 5`.

---

#### S5. `max_tokens: 1_200` in web search request

**File:** `apps/backend/src/routes/chatPrompts.ts:162`

Bare max_tokens for web search completions. Should be a named constant tied to the web search use case.

---

#### S6. `stepCountIs(6)` in both chat routes

**Files:**
- `apps/backend/src/routes/contextChat.ts:299`
- `apps/backend/src/routes/libraryChat.ts:239`

**Details:** Both chat routes hardcode `stopWhen: stepCountIs(6)` — the maximum tool-calling steps. This is a safety limit that prevents infinite tool loops. If the limit needs adjustment, it must be changed in two places.

**Recommendation:** Define `MAX_CHAT_TOOL_STEPS = 6` in `chatConfig.ts`.

---

### MEDIUM FINDINGS

---

#### M6. `maxResults: 8` default in `searchLibrary` tool executor

**File:** `apps/web/services/library/toolExecutor.ts:254`

The fallback value `8` for search max results is a magic number.

**Recommendation:** Define as `DEFAULT_LIBRARY_SEARCH_MAX_RESULTS`.

---

#### M7. Magic string `'local-bypass'` in auth config response

**File:** `apps/backend/src/routes/projects.ts:21`

```ts
config: {
  ...getProjectStore().getConfig(),
  authMode: 'local-bypass',
  userId: currentUser.id,
},
```

The string `'local-bypass'` is a bare auth mode identifier.

**Recommendation:** Define as `AUTH_MODE_LOCAL_BYPASS` constant.

---

#### M8. Various magic numbers in retry logic

**Files:**
- `apps/web/services/openrouter/retry.ts:54–56` — `retries = 3`, `delay = 1000`
- `apps/web/services/openrouter/curriculum.ts:235–236` — `retries = 2`, `delay = 1000`
- `apps/web/services/openrouter/laboratory.ts:439, 444, 526, 565, 585, 669` — various `retryWithBackoff` calls with `2, 500`

**Details:** Multiple retry counts and delay values are hardcoded at each call site.

**Recommendation:** Define named constants or a central retry policy module.

---

### SMALL FINDINGS

---

#### S4. `'Conclusione'` heading regex in `planGeneration.ts`

**File:** `apps/web/services/openrouter/planGeneration.ts:1018`

```ts
const LESSON_CONCLUSION_HEADING_REGEX = /(^|\n)#{1,6}\s+Conclusione\b/i;
```

This hardcodes Italian-language regex for detecting conclusion headings. If the app supports non-Italian lessons, this won't match.

**Recommendation:** Make this language-configurable or at least document the Italian-only assumption.

---

#### S5. `MAX_ASSESSMENT_SOURCE_CHARS = 6000` — appears in two contexts

**Files:**
- `apps/web/services/openrouter/assessment.ts:9` — `MAX_ASSESSMENT_SOURCE_CHARS = 6000`
- `apps/web/services/openrouter/assessment.ts:12` — `MAX_ASSESSMENT_SOURCE_PREVIEW_BYTES = 12_000`

These are well-named constants but the relationship between them (preview bytes ~2× source chars) isn't obvious without reading the code. Not a severe issue but documenting the constraint would help.

---

## Category 3: Configuration and Aesthetic Constants

### MEDIUM FINDINGS

---

#### M9. `serverConfig` imported directly from JSON in frontend config

**File:** `apps/web/services/openrouter/config.ts:1`

```ts
import serverConfig from '../../../../server.config.json';
```

**Details:** The frontend imports the server config JSON file directly to get default host/port values. This couples the frontend build to the existence of `server.config.json` in the repo root. If the file is missing or renamed, the import will fail at build time.

**Recommendation:** Use environment variables (`VITE_BACKEND_HOST`, `VITE_BACKEND_PORT`) with hardcoded fallbacks instead of importing a JSON config file that may not exist in production builds.

---

#### M10. UI motion tokens are centralized but only partially used

**File:** `apps/web/utils/motion/tokens.ts`

**Details:** The file defines excellent named tokens (`SPRING_SNAPPY_POP`, `VARIANTS_DIALOG`, `TAP_SCALE`, etc.). However, in `App.tsx`, some animations are defined inline (e.g., `className="transition-colors hover:bg-gray-100"` strings) rather than using the token system. The `MOTION_DURATION`/`MOTION_EASING` constants are defined but not all UI components reference them.

This is good practice overall — the token system exists and is used in `motion/primitives.tsx`. The inconsistency is minor.

**Recommendation:** Audit all Tailwind `transition-*` classes in JSX and consider whether they should reference motion tokens for consistency.

---

### SMALL FINDINGS

---

#### S6. Background music URL handling uses inline strings

**File:** `apps/web/services/workspace/domain.ts:15` — the `'set-music-url'` action type string

The domain action type strings (`'reset'`, `'hydrate'`, `'set-source'`, etc.) are bare strings in the reducer. These could be a const enum or string union but are used consistently through the codebase.

**Recommendation:** Low priority. If the reducer grows significantly, consider `as const` type narrowing.

---

## Category 4: Code Style & Modern APIs

### MEDIUM FINDINGS

---

#### M11. `parseInt` without radix in `config.ts`

**File:** `apps/web/services/openrouter/config.ts:17`

```ts
export const MAX_OUTPUT_TOKENS = parseInt(process.env.MAX_OUTPUT_TOKENS || '32000', 10);
```

This actually uses radix `10` — **OK.** Reviewing other `parseInt` calls...

**File:** `apps/backend/src/config/serverConfig.ts:21`

```ts
const parsed = Number.parseInt(String(value ?? ''), 10);
```

**OK** — radix is explicit.

No `parseInt` without radix found. **No issue.**

---

#### M12. `Array.from(new Set(...))` pattern used inefficiently in places

**File:** `apps/backend/src/services/pdfImageExtractor.ts:88–96`

```ts
const cleaned = Array.from(
  new Set(
    partialPages.filter(page => Number.isInteger(page) && page > 0).map(page => Math.trunc(page))
  )
).sort((left, right) => left - right);
```

This pattern (filter → map → Set → Array → sort) is correct but verbose. `[...new Set(...)]` would be slightly more concise, though this is a matter of preference. **Not a real issue.**

---

#### M13. `sleep`/`wait` defined as `setTimeout` wrapper in `retry.ts`

**File:** `apps/web/services/openrouter/retry.ts:6`

```ts
export const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
```

This is a standard pattern. **OK.** However, it's only used in `retry.ts` and `processManager.ts` (which has its own inline `setTimeout` patterns). The `processManager` uses:
```ts
await new Promise(resolve => setTimeout(resolve, 5000));
await new Promise(resolve => setTimeout(resolve, 2000));
```
Could import `wait` from `retry.ts` for consistency. **Small.**

---

### SMALL FINDINGS

---

#### S7. `.replace(/\r\n?/g, '\n')` pattern repeated extensively

**Files:** Many files across the codebase

The line-ending normalization `text.replace(/\r\n?/g, '\n')` appears in:
- `apps/backend/src/services/pdfImageExtractor.ts:103`
- `apps/backend/src/services/pdfTextExtractor.ts:28, 35, 83, 96`
- `apps/web/services/openrouter/assessment.ts:45, 72`
- `apps/web/services/laboratory/attachments.ts:28`
- `apps/web/services/openrouter/contextChat.ts:7`
- `apps/web/services/openrouter/documentIndex.ts:135`
- Many more in `utils/markdown/render.ts`

**Recommendation:** Extract as `normalizeLineEndings(text)` utility.

---

#### S8. `new Date().toISOString()` pattern appears ~50+ times

This is ubiquitous throughout the codebase. While not a magic number (it's an API call), wrapping in a utility like `timestamp()` would reduce visual noise. **Low priority.**

---

## Category 5: Documentation of Non-Obvious Tradeoffs

### SMALL FINDINGS

---

#### S9. JSON repair pipeline in `json.ts` lacks explanation

**File:** `apps/web/services/openrouter/json.ts:56–169`

**Details:** The `cleanJson`, `repairJsonString`, and `closeOpenJsonStructures` functions implement a multi-stage JSON repair strategy (clean → repair → close). This is a sophisticated workaround for LLM-generated JSON that may be truncated or malformed. The approach is correct but lacks a comment explaining:
1. Why three passes are needed instead of one
2. What specific LLM output patterns each pass handles
3. That this is a best-effort heuristic, not a validator

**Recommendation:** Add a docstring explaining the repair pipeline.

---

#### S10. Soft timeout pattern in `planGeneration.ts`

**File:** `apps/web/services/openrouter/planGeneration.ts:111–141`

**Details:** The `withSoftTimeout` and `SoftTimeoutError` classes implement a custom timeout that differs from `AbortSignal.timeout()`. The code doesn't explain why `AbortSignal.timeout()` wasn't sufficient — the soft timeout allows the underlying promise to continue (it's not truly cancelled), which is a deliberate design choice that should be documented.

**Recommendation:** Add a comment: "We use a soft timeout rather than AbortSignal because we want to let the LLM request complete in the background for debugging/logging even if the UI has moved on."

---

#### S11. `PDfImageExtractor`'s complex inline/rendered threshold system

**File:** `apps/backend/src/services/pdfImageExtractor.ts:131–187`

**Details:** The `isPdfImageTooSmallForStandaloneFigure` function uses a sophisticated multi-criterion test with several named constants:
- `STANDALONE_INTRINSIC_IMAGE_MIN_SHORT_SIDE = 72`
- `STANDALONE_INTRINSIC_IMAGE_MIN_MAX_DIMENSION = 220`
- `STANDALONE_INTRINSIC_IMAGE_MIN_AREA = 24_000`
- `STANDALONE_RENDERED_IMAGE_MIN_SHORT_SIDE = 72`
- `STANDALONE_RENDERED_IMAGE_MIN_MAX_DIMENSION = 140`
- `STANDALONE_RENDERED_IMAGE_MIN_AREA = 10_000`
- `UPSCALED_IMAGE_RENDERED_MIN_SHORT_SIDE = 140`
- `UPSCALED_IMAGE_MIN_SHORT_SIDE_RATIO = 0.8`
- `UPSCALED_IMAGE_MIN_AREA_RATIO = 0.6`
- `UPSCALED_IMAGE_MAX_INTRINSIC_MAX_DIMENSION = 260`
- `INLINE_RENDERED_IMAGE_MIN_DIMENSION = 90`
- `INLINE_RENDERED_IMAGE_MIN_AREA = 14_000`

All these are well-named constants — excellent. However, the rationale for these specific thresholds isn't documented. Were they determined empirically from PDF test cases? Are they heuristics that may need tuning?

**Recommendation:** Add a brief comment explaining that these thresholds were empirically determined from PDF test corpora.

---

## Summary

| Category | SEVERE | MEDIUM | SMALL | Total |
|----------|--------|--------|-------|-------|
| Single Source of Truth | 5 | 5 | 3 | 13 |
| Magic Numbers/Strings | 3 | 3 | 2 | 8 |
| Configuration Constants | 0 | 2 | 1 | 3 |
| Code Style/Modern APIs | 0 | 1 | 2 | 3 |
| Documentation of Tradeoffs | 0 | 0 | 3 | 3 |
| **Total** | **8** | **11** | **11** | **30** |

### Top Priority Actions

1. **Extract shared project identity logic** (S1) — the duplicated `buildProjectMeta`, `getProjectTitle`, `createProjectId`, etc. between backend and frontend is the highest-risk duplication in the codebase.
2. **Eliminate `planning.ts` duplication** (S2) — consolidate `planGeneration.ts` and `planning.ts` into a shared planning module.
3. **Merge `buildContextWebSearchMandate` / `buildLibraryWebSearchMandate`** (M4) — these are identical functions.
4. **Centralize web search tool creation** (S3) — factor out shared web search tool factory from context and library chat routes.
5. **Name magic step count and search defaults** (S4, S5, S6) — `stepCountIs(6)`, `maxResults || 5`, `1_200` should all be named constants.
6. **Remove direct `server.config.json` import from frontend** (M9) — use env vars with fallbacks.
