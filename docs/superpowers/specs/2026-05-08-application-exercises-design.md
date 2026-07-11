# Application Exercises Intercalated in the Path — Design

**Date:** 2026-05-08
**Status:** Implemented; retained as the historical design record. Current terminology and architecture live in [`CONTEXT.md`](../../../CONTEXT.md) and [`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md).

## Context

Today the app has two parallel concepts:

- **Learning plan / lessons** — `LearningPlan { sections: LearningSection[] }`, lessons generated lazily, rendered in the workspace sidebar. Two course modes: PDF-document and research-based (Nous).
- **Laboratorio** — a separate `LaboratoryState { exercises: LaboratoryExercise[] }` with its own UI surface, its own "genera laboratorio" button, and its own evaluation pipeline.

The Laboratorio sits outside the path. Users have to leave the lesson flow to interact with applied work, which weakens the connection between what they just learned and what they're being asked to apply.

This refactor folds applied exercises **into** the path as first-class nodes alongside lessons. Lessons and exercises share the same sidebar, the same path, the same lazy-generation UX. The only difference is the icon and the inner content. The Laboratorio system is removed entirely.

The difference between PDF-mode and research-mode courses remains exactly as today: only the primary source layer differs (chunks vs dossiers).

## Decisions made during brainstorming

| Axis | Decision |
|---|---|
| Module representation | **Real structural container.** `LearningPlan.modules: LearningModule[]`, each with `children: PathNode[]`. |
| Sub-chapters (`parentId`) | **Preserved**, nested inside their module's children. ApplicationExerciseNodes never have a parentId. |
| `assessedObjective` format | **Free text** written by the planning pass, persisted on the node. |
| Legacy Laboratory cleanup | **Hard delete now.** Types, services, components, tests, button — all gone. |
| Course completion math | **Separate fields.** `lessonCount`/`completedCount` stay lesson-only. New `exerciseCount`/`completedExercises`. |
| Implementation sequencing | **Big-bang.** No parallel-data-model period; type errors guide the refactor. |

## Data model

### Plan-level

```ts
interface LearningPlan {
  title: string;
  summary: string;
  generationNotes?: string;
  backgroundMusicUrl?: string;
  modules: LearningModule[];
  applicationExercisePlanningStatus: 'not-run' | 'completed' | 'failed';
  applicationExercisePlanningNotes?: string;
  applicationExercisePlanningError?: {
    message: string;
    attempts: number;
    lastAttemptAt: string;
  };
}

interface LearningModule {
  id: string;
  title: string;
  description?: string;
  type?: 'prerequisite' | 'core' | 'summary' | 'deep-dive';
  children: PathNode[];
}

type PathNode = LessonNode | ApplicationExerciseNode;
```

### Lesson node

`LessonNode` is `LearningSection` minus `moduleTitle`, plus a discriminator:

```ts
interface LessonNode {
  kind: 'lesson';
  id: string;
  title: string;
  description: string;
  isCompleted: boolean;
  type: 'prerequisite' | 'core' | 'summary' | 'deep-dive';
  parentId?: string;
  content?: string;
  quiz?: QuizQuestion[];
  imageRefs?: LessonImageRef[];
  generatedVisuals?: LessonGeneratedVisual[];
  contextPrompt?: string;
  primaryChunkIds?: string[];
  primaryChunkMappingSource?: 'fallback' | 'mapped';
  annotations?: SectionAnnotation[];
}
```

### Exercise node

```ts
interface ApplicationExerciseNode {
  kind: 'exercise';
  id: string;
  title: string;
  description: string;
  assessedObjective: string;        // planning-pass output, immutable until rerun
  brief?: string;                   // generated lazily on first open
  internalText?: string;            // user's in-app deliverable
  attachments: ExerciseAttachment[];
  currentFeedback: ExerciseFeedback | null;
  bestScore?: number;
  completedAt?: string;
  isCompleted: boolean;             // monotonic
  feedbackStale: boolean;
  groundingSources?: ResearchSourceReference[]; // from brief generation web search
  generatedAt?: string;             // brief generation timestamp
  updatedAt: string;
}

type ExerciseAttachmentKind = 'text' | 'archive';

interface ExerciseAttachment {
  id: string;
  name: string;
  mimeType: string;
  kind: ExerciseAttachmentKind;
  data: string;                     // base64 for archive, plain text for text
  description?: string;
  truncated: boolean;
  truncatedReason?: string;
  createdAt: string;
  updatedAt: string;
}

interface ExerciseFeedback {
  evaluatedAt: string;
  score: number;                    // 0..100
  qualitativeLabel: string;         // LLM, in user language ("Solido tentativo")
  summary: string;
  strengths: string[];
  improvements: string[];
  caveats: string[];
  verifiedSources?: ResearchSourceReference[]; // from feedback web search
}
```

### Centralized constants

A single module `apps/web/services/exercises/constants.ts` exports:

```ts
export const EXERCISE_PASS_THRESHOLD = 60;
export const EXERCISE_MAX_ENTRIES = 10;
export const EXERCISE_MAX_TOTAL_CHARS = 50_000;
export const EXERCISE_MAX_ENTRY_CHARS = 20_000;
export const EXERCISE_TEXT_EXTENSION_ALLOWLIST: ReadonlySet<string>;
export const EXERCISE_ZIP_IGNORE_DIRS: ReadonlySet<string>;
```

### `SavedProjectMeta`

Add `exerciseCount: number` and `completedExercises: number`. Existing `lessonCount`/`completedCount` continue to mean lessons only.

## Migration

`prepareSnapshotForHydration` performs a one-way upgrade:

1. **Sections → modules:** consecutive `LearningSection`s sharing the same `moduleTitle` form one `LearningModule` with that title; sections with no `moduleTitle` form a default "Untitled module" run. Each section becomes a `LessonNode` (drop `moduleTitle`, stamp `kind: 'lesson'`). Sub-chapters (`parentId`) end up in the same module as their parent lesson.
2. **Module IDs:** generated stably from `(position, slug(moduleTitle))` so re-hydrating the same snapshot yields the same IDs. Position is included as the primary component to avoid collisions between modules sharing a title.
3. **Module type:** if every lesson in the module shares a `LearningSection.type`, that becomes `LearningModule.type`; otherwise undefined.
4. **Laboratory:** the `laboratory` field on `ProjectSnapshot` is silently dropped. No conversion attempt. No exercises are auto-generated for legacy plans.
5. **Planning status:** legacy plans get `applicationExercisePlanningStatus = 'not-run'`. The user can run a one-shot "repair" (sidebar header button) to invoke the placement pass on a legacy course.
6. **`SavedProjectMeta`:** legacy meta gets `exerciseCount: 0`, `completedExercises: 0`. (`lessonCount`/`completedCount` recomputed from migrated nodes for safety.)

Hard-delete consequences (no soft tombstone):

- All `Laboratory*` types deleted from `apps/web/types.ts`.
- `ProjectSnapshot.laboratory` field removed. IndexedDB blobs for old projects still contain it; it just isn't read.
- `apps/web/services/laboratory/`, `apps/web/services/openrouter/laboratory.ts`, `apps/web/components/workspace/laboratory/`, `apps/web/tests/services/openrouter/laboratory.test.ts`, `apps/web/tests/utils/laboratoryFileFilter.test.ts` — all deleted.
- `readerShellProps.ts` loses `onGenerateLaboratory` and related wiring.
- `WorkspaceReaderSidebar.tsx` loses the laboratory list section + "genera laboratorio" button.

## AI pipelines

### Phase 1 — Exercise placement pass

New service: `apps/web/services/openrouter/exercisePlacement.ts`.

- **When:** runs immediately after `generateLearningPlan` completes, before the project is shown to the user.
- **Model:** same OpenRouter model identifier as the Nous lesson-content generator. Model id is read from one constant (`apps/web/services/openrouter/models.ts` or wherever the existing constant lives — to be located during implementation).
- **Inputs:** `UserProfile`, `LearningPlan` (just-generated), `courseIntent`, and a one-line summary of each module (title + lesson titles + top concepts pulled from descriptions; for research-mode courses, the dossier `keyExamples` are included; for PDF-mode, lesson `description` text).
- **Tools:** none. The pass cannot do external research.
- **Output schema (validated post-LLM):**

  ```ts
  interface ExercisePlacementResult {
    rationale: string;
    placements: Array<{
      moduleId: string;
      title: string;
      description: string;
      assessedObjective: string;
    }>;
  }
  ```

- **Validation rules (enforced in code, not just by prompt):**
  - At most one placement per `moduleId`. Duplicates rejected; the result is invalid.
  - `moduleId` must reference an existing module.
  - `assessedObjective` non-empty, ≤ 280 characters after trim.
  - Title and description non-empty.
- **Placement insertion:** the `ApplicationExerciseNode` is appended as the **last child** of the named module. Initial state: no `brief`, empty `attachments`, no `currentFeedback`, `isCompleted: false`, `feedbackStale: false`.
- **Zero-placements outcome:** valid. `applicationExercisePlanningStatus` becomes `'completed'`, `applicationExercisePlanningNotes` is set to the rationale.
- **Retry policy:** up to 2 attempts, 1.5× backoff. On final failure: `applicationExercisePlanningStatus = 'failed'`, `applicationExercisePlanningError` populated, course remains valid.
- **Manual rerun:** sidebar context menu entry "Rigenera esercizi". Destructive: wipes every `ApplicationExerciseNode` in the plan, then runs the placement pass. No merge / preserve mode.

### Phase 2 — Lazy brief generation

New service: `apps/web/services/openrouter/exerciseBrief.ts`.

- **Trigger:** user opens an exercise whose `brief` is empty.
- **Precondition gate:** every `LessonNode` from the start of the course up to (and excluding) the exercise must have non-empty `content`. If any are missing, the viewer renders a blocking info panel listing the gaps and a hint to generate them. The brief generator is **not** called.
- **Focus segment:** walking from the exercise backwards through all modules' children flattened into a path order, the focus segment is `[previousExerciseNode + 1 ... thisExerciseNode - 1]`. Everything earlier is *available prerequisite material*, not focus.
- **Material assembly:**
  - Focus lessons: full `content` markdown, with embedded quiz / active-pause / generated-visual sections stripped via the lesson generator's anchor markers.
  - Prerequisite lessons: just titles + descriptions.
  - Source layer: PDF-mode pulls chunks referenced by `primaryChunkIds` of focus lessons; research-mode pulls dossiers for the focus lesson IDs.
- **Tools:** OpenRouter web search **enabled**. Prompt rules forbid using it to introduce concepts not in the course; allowed only to find pattern/idea inspiration for exercise framing. Cited URLs are appended to `groundingSources` (reusing `ResearchSourceReference`).
- **Output:** `{ briefMarkdown: string; groundingSources?: ResearchSourceReference[]; plannerNotes?: string }`. Persisted on the node along with `generatedAt`.
- **Invariants:** existing `assessedObjective`, `title`, `description` are immutable through brief generation.
- **Regenerate brief** (button on exercise viewer header): destructive — wipes `brief`, `internalText`, `attachments`, `currentFeedback`, `bestScore`, `completedAt`; sets `isCompleted: false`, `feedbackStale: false`. Decrements `completedExercises` if the exercise was previously completed. Confirmation dialog.

### Status surface

The existing reasoning/status callback channel transports new macro labels in user language:

- "Scelgo dove inserire gli esercizi…" — placement pass
- "Controllo le lezioni precedenti…" — precondition gate
- "Raccolgo il materiale…" — material assembly
- "Cerco idee di esercizi…" — only emitted when web search is invoked
- "Genero la consegna…" — LLM call
- "Verifico la traccia…" — output validation

UI for synthesized reasoning is out of scope.

## Submission + feedback

### Deliverable composer

The exercise viewer renders two regions when `brief` is present:

- **Brief pane** (read-only): markdown, `groundingSources` footer if present.
- **Composer pane:** one optional `internalText` textarea + an attachment dock.

Attachment dock service: `apps/web/services/exercises/deliverables.ts`.

**Validation rules** (one shared validator across `internalText` + entries + extracted zip contents):

- Accepted upload kinds: `text` (single text file), `archive` (zip). Anything else rejected at upload time with a clear message.
- Per-entry text allowlist: `.md, .txt, .json, .yaml, .yml, .toml, .csv, .tsv, .ts, .tsx, .js, .jsx, .py, .rs, .go, .java, .c, .cpp, .h, .css, .scss, .html`. Centralized constant.
- Budgets: ≤ 10 entries (text + zip-extracted, combined), ≤ 50,000 chars total, ≤ 20,000 chars per entry. `internalText` counts toward the total.
- Truncation: when a text entry exceeds the per-entry cap, truncate at the last block boundary (paragraph for prose; top-level statement for code via simple line-break heuristic). Set `truncated: true` and `truncatedReason` on the entry.

**Zip filtering algorithm** (deterministic):

1. Skip dot-folders and the hardcoded ignore set: `node_modules`, `dist`, `build`, `target`, `.next`, `.cache`, `coverage`, `__pycache__`.
2. Drop binary entries (mime not in allowlist + extension not in allowlist).
3. Sort surviving entries by `(depth ASC, sibling-count-of-parent-dir ASC, file-length ASC, path ASC)`. Last key is stable tie-break.
4. Take entries in order until the global budget is exhausted. The entry that would overflow the global cap is **skipped** (not partially included), unless it alone fits within `EXERCISE_MAX_ENTRY_CHARS` and there is room left — then truncate at the last block boundary and include.

The validator returns `{ entries, totalChars, truncations[], dropped[] }`. The dock surfaces the dropped/truncated info verbatim and passes truncation summaries to the LLM during evaluation.

### Submitting and feedback

- **CTA:** "Richiedi riscontro" (or "Aggiorna riscontro" when `feedbackStale`). Enabled when `internalText.length > 0 || attachments.length > 0` and not currently evaluating.
- **Service:** `apps/web/services/openrouter/exerciseFeedback.ts`.
  - **Inputs:** `assessedObjective`, `brief`, the same materials passed to the brief generator (focus + prerequisites + source layer), the validated deliverable (with truncation caveats), and the user's language.
  - **Tools:** OpenRouter web search **enabled, restricted**. Prompt rule: use only to verify external facts/APIs/versions the user cited. Forbidden for expanding evaluation criteria. URLs cited are appended to `verifiedSources` on the feedback (separate from brief's `groundingSources`).
  - **Output:** `ExerciseFeedback`.
- **Persistence on success:**
  - `currentFeedback = result`.
  - If `score >= EXERCISE_PASS_THRESHOLD && !isCompleted`: set `isCompleted: true`, `completedAt: now`, `bestScore: score`. Increment `completedExercises` on `SavedProjectMeta`.
  - If `score >= (bestScore ?? 0)`: update `bestScore`. (Monotonic.)
  - If `isCompleted` was already true: no completion-state changes regardless of score.
  - Always: `feedbackStale = false`.
- **On failure:** prior `currentFeedback` retained, error surfaced inline. No automatic retry.
- **No history:** prior feedback is overwritten.

### Stale feedback

- Editing `internalText` or any attachment after a `currentFeedback` exists ⇒ `feedbackStale = true`. Existing feedback stays visible (greyed/labelled "Riscontro datato"). The submission CTA renames to "Aggiorna riscontro". A new feedback request replaces `currentFeedback` and clears `feedbackStale`.

### Regeneration cascades summary

| Trigger | Effect on exercise |
|---|---|
| Edit deliverable text/attachments after feedback | `feedbackStale = true`; feedback retained until "Aggiorna riscontro" |
| Regenerate brief | Wipes brief + internalText + attachments + currentFeedback + bestScore + completedAt; `isCompleted = false`; `feedbackStale = false`. If the exercise was previously completed, decrement `SavedProjectMeta.completedExercises`. |
| Regenerate previous lesson's content | No effect on downstream exercises |
| Rerun placement pass | All exercises wiped and re-planned from scratch. `SavedProjectMeta.completedExercises` reset to 0; `exerciseCount` reset to the new placement count. |

## UI

### Sidebar

- One unified node list per module. Module renders as a header; children render in path order with their existing nesting (parentId still respected for lessons).
- Lessons keep their current icon. Exercises get a distinct icon (placeholder name `ApplicationExerciseIcon` — concrete glyph chosen during implementation; not gated by this spec).
- Status indicators on exercises:
  - Empty (planned, no brief) — neutral placeholder dot.
  - Brief generated, no submission — open dot.
  - Feedback present, not completed — partial dot, "X/100".
  - Completed — filled dot, "X/100" using `bestScore`.
  - Stale feedback — partial dot with stripe.
- Sidebar header gains a small banner when `applicationExercisePlanningStatus === 'failed'`: "Pianificazione esercizi fallita" + retry button.
- Sidebar context menu adds "Rigenera esercizi" (destructive). The legacy "Rigenera laboratorio" entry is removed.
- Legacy "genera laboratorio" button removed.

### Exercise viewer

- Header: title, description, `assessedObjective`, "Rigenera traccia" button.
- Body when `brief` empty + precondition met: brief generation **auto-runs on open**, matching the existing lesson UX (opening an ungenerated lesson auto-triggers content generation today).
- Body when `brief` empty + precondition NOT met: blocking info panel with the list of missing prerequisite lessons.
- Body when `brief` present: split layout — brief pane on the left, deliverable composer on the right, feedback section below the composer when `currentFeedback` exists.
- Reasoning/status panel reuses the existing channel and renders the macro labels listed earlier.

### Feedback display

- Header row: `qualitativeLabel`, `score / 100`, "Riscontro datato" tag if stale.
- Sections: `summary` (paragraph), `strengths` (list), `improvements` (list), `caveats` (list, dimmer styling). `verifiedSources` rendered as a footer if non-empty.

### Out of scope for this PR

- Synthesized reasoning UI.
- Reorder/move exercises across modules.
- Manual exercise insertion.
- Image/audio/video deliverables (not a fundamental limit; deferred).

## Tests

### Migration / hydration

- Old snapshot with `learningPlan.sections[]` + `laboratory{...}` hydrates to: `learningPlan.modules[]`, no exercises, `applicationExercisePlanningStatus: 'not-run'`, `laboratory` field absent.
- Stable module IDs across re-hydration of the same snapshot.
- Sub-chapter `parentId` preserved within the parent's module.
- `SavedProjectMeta.completedCount` recomputed correctly; `exerciseCount: 0`, `completedExercises: 0` defaulted.

### Placement pass

- Zero placements is a valid outcome → status `completed`, notes saved.
- Duplicate `moduleId` placements rejected (validator).
- Unknown `moduleId` rejected.
- Placement always appended as last child of its module.
- `assessedObjective` required, ≤ 280 chars.
- "Rigenera esercizi" wipes existing exercises before invoking the pass.
- Failed pass after retries: status `failed`, error populated, course remains openable.

### Brief generation

- Blocks when prior lesson content is missing; does not auto-generate lessons.
- Focus segment computation correct (across modules, between previous exercise and current one).
- PDF-mode includes chunks of focus lessons; research-mode includes dossiers.
- Quiz / active-pause / visual sections stripped from focus lesson markdown.
- `groundingSources` populated only when web search is invoked.
- Regenerate brief resets all node state.

### Deliverable validation

- Per-entry char cap with block-boundary truncation; `truncated: true` set.
- Total char cap enforced across `internalText` + entries.
- Entry-count cap (≤ 10).
- Zip filtering: dot-folder and ignore-set excluded; binaries dropped; sort order matches the documented tuple; tie-break stable.
- Image / pdf / binary uploads rejected at upload time.
- Truncation summary surfaced to the LLM via caveats.

### Feedback / completion

- Score ≥ threshold marks the exercise completed and increments `completedExercises`.
- Completion is monotonic: a lower subsequent score does not unset `isCompleted`.
- `bestScore` never decreases.
- Editing deliverable after feedback sets `feedbackStale: true`; resubmit clears it.
- No feedback history retained.

### Regression

- PDF-mode lesson generation unchanged.
- Research-mode lesson generation produces quiz / visuals as today.
- Old projects open without crashing; `laboratory` JSON in IDB is silently ignored.

### Validation gates (final)

- `bun run quality`
- `bun run gate`
- `graphify update .`

## Implementation sequence

1. **Types + constants** — define new types, add `kind` discriminator, drop laboratory types. Land migration in `prepareSnapshotForHydration`. Snapshot persistence updated.
2. **Sidebar + viewer skeleton** — render modules + nodes from the new model. Lesson rendering equivalent to today; exercise viewer is a stub. No exercise generation yet.
3. **Placement pass** — service + validator + retry + status persistence. New courses run the pass. Manual "Rigenera esercizi".
4. **Brief generation** — service + precondition gate + focus computation + material assembly + status labels. "Rigenera traccia" wired up.
5. **Deliverable composer + validator** — text + zip pipeline, budgets, truncation, dropped/truncated UI surface.
6. **Feedback service + completion math** — `currentFeedback` persistence, monotonic completion, `bestScore`, `feedbackStale`, meta counter updates.
7. **Cleanup pass** — delete legacy laboratory files, tests, wiring; verify zero references via type check.
8. **Test passes** — fill in test cases noted above; run `bun run gate`.
9. **graphify update** — refresh the knowledge graph.

Each step ends with `bun run test` green for the affected scope.

## Assumptions

- Sufficiency threshold default is `60/100`. Centralized constant; can be changed in one place.
- The placement pass is auto-invoked only at course creation time. Legacy courses opt in via a manual "Rigenera esercizi".
- The placement pass does not perform external research. Web search is restricted to brief generation (idea inspiration) and feedback (verifying user-cited facts).
- The Nous model identifier is reused as a constant; the placement pass uses the same model as Nous lesson generation.
- IndexedDB schema does not need versioning beyond what the existing snapshot version mechanism provides; old `laboratory` JSON is ignored at hydration, and the snapshot is rewritten on next save without it.
- Synthesized-reasoning UI and richer deliverable kinds are explicitly out of scope.
- Blast radius is medium-high; this is acknowledged and accepted.

## Non-goals

- Backwards-compat shim for the laboratory data shape.
- Image/audio/video deliverables.
- Manual reorder or insertion of exercises.
- Cross-course progress aggregation views.
- Multi-attempt history per exercise.
