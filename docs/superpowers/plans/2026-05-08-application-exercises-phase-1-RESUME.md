# Phase 1 — Resume Notes

> **Last session:** 2026-05-08. Stopped mid-Phase-1 due to weekly Claude budget.
> **Branch:** `worktree-application-exercises-refactor` (worktree at `.claude/worktrees/application-exercises-refactor`).
> **Spec:** [2026-05-08-application-exercises-design.md](../specs/2026-05-08-application-exercises-design.md)
> **Plan:** [2026-05-08-application-exercises-phase-1-data-model.md](2026-05-08-application-exercises-phase-1-data-model.md)

## How to resume

```bash
cd .claude/worktrees/application-exercises-refactor
git log --oneline | head -20
bun run lint:frontend 2>&1 | grep -E "error TS" | wc -l
bun run lint:frontend 2>&1 | grep -E "error TS" | grep -v "tests/" | awk -F'(' '{print $1}' | sort | uniq -c | sort -rn
```

Tell the orchestrator: "Continue Phase 1 from RESUME notes." Hand it this file.

## Current state (last verified at commit `680e11f`)

- **236 type errors** remaining; **0** in source files except those listed below.
- All source files have been type-checked and updated except the ones in §"Remaining work — sources".
- The only pre-existing source error is `apps/web/services/projects/projectSnapshot.ts(402,3)` about `recentDevelopments` missing on `ResearchLessonDossier` — predates this refactor; ignore.

## What's done

| Plan task | Status | Commits |
|---|---|---|
| T1 — centralized exercise constants | ✅ | `0c0439d` |
| T2 — add ApplicationExerciseNode/LearningModule/PathNode types | ✅ | `2dbe194` |
| T3 — `groupSectionsIntoModules` migrator (TDD, 8/8 tests) | ✅ | `229fad5` |
| T6 — `pathNodes` helpers: `flattenPathNodes`, `flattenLessons`, `findPathNodeById`, `updateLessons`, `flattenLessonsWithModuleContext` | ✅ | `2af10a3`, `656ad21` |
| T4 — schema swap: `LearningPlan.modules`, `ProjectSnapshot` drops laboratory, `SavedProjectMeta` adds exercise counts | ✅ (broken-state commit, annotated) | `d1b3085` |
| T5 — planner emits modules via `groupSectionsIntoModules` | ✅ | `1dcd599` |
| T7 — `prepareSnapshotForHydration` migrates legacy snapshots, drops laboratory | ✅ | `d2de304` |
| T12 — delete laboratory source/test files (8 files) | ✅ | `83ff2bb` |
| T13 partial — `projectSnapshot.ts` rewired (meta computation + parsing + export drop laboratory) | ✅ | `8e3d751` |
| Persistence — `persistenceSignature.ts`, `indexedDbProjectRepository.ts` | ✅ | `3747753` |
| Workspace — `services/workspace/domain.ts`, `useWorkspaceDomain.ts`, `WorkspaceDomainState`, `sectionTree.ts` LearningSection→LessonNode | ✅ | `a573a2c` |
| Controller — `controller/types.ts`, `sectionProgression.ts` | ✅ | `6168fb1` |
| documentIndex — `mapping.ts`, `coverage.ts` | ✅ | `656ad21` |
| Consumers — `workspaceReader.ts`, `library/assistant.ts`, `planQuality.ts`, `pdf/projectHydration.ts` | ✅ | `039cbe6` |
| Library — `useProjectLibrary.ts` | ✅ | `680e11f` |

## Remaining work — sources (~30 small errors across 18 files)

All errors fall into 3 patterns. Apply the same recipes used so far:

**Pattern A — `plan.sections` references:**
- `apps/web/app/useInitialSectionAutoOpen.ts:53` — `plan.sections` → `flattenLessons(plan.modules)`
- `apps/web/hooks/library/useLibraryAssistantChat.ts:264` — same
- `apps/web/hooks/workspace/controller/assessmentPlanning.ts:320, 387` — same
- `apps/web/hooks/workspace/useWorkspaceReaderActions.ts:133` — same
- `apps/web/services/workspace/controller/documentAssets.ts:14` — same
- `apps/web/services/workspace/controller/learnMode.ts:9, 32, 51` — same; line 51 builds a `{}` cast to LearningSection — adapt to LessonNode
- `apps/web/services/openrouter/research.ts:204` — building `{ ...plan, sections: ... }` → `{ ...plan, modules: groupSectionsIntoModules(...) }`
- `apps/web/utils/learning/artifacts.ts:207, 310` — same; line 310 has a cast to ProjectSnapshot that needs `modules` not `sections`
- `apps/web/utils/learning/lessonGenerationState.ts:18` — same
- `apps/web/utils/library/assistant.ts:264, 303` — `lesson.moduleTitle` no longer exists; either remove (output omits moduleTitle for the assistant payload) or fetch the parent module title via a `flattenLessonsWithModuleContext` walk

**Pattern B — Laboratory imports / wiring (UI shell):**
- `apps/web/components/workspace/shell/types.ts` — drop imports of `LaboratoryExercise`, `LaboratoryStateStatus`; **strip** every laboratory* field from the model interfaces:
  - `WorkspaceReaderSidebarModel`: `activeLaboratoryExerciseId`, `laboratoryExercises`, `laboratoryStatus`, `laboratoryTitle`, `onGenerateLaboratory`, `onRegenerateLaboratoryIndex`, `onSelectLaboratoryExercise`. Change `onSelectSection: (section: LearningSection) => void` to `LessonNode`.
  - `WorkspaceReaderHeaderModel`: drop `activeLaboratoryExercise`, `isLaboratoryView`, `laboratoryTitle`, `onRegenerateActiveLaboratoryExercise`.
  - `WorkspaceReaderContentModel`: drop ~20 `*Laboratory*` fields.
- `apps/web/components/workspace/shell/WorkspaceReaderContent.tsx:12` — drop import of `../laboratory/WorkspaceLaboratoryContent.tsx`; remove its render branch.
- `apps/web/app/readerShellProps.ts:6` — drop import of `../services/laboratory/state.ts`; lines 59, 70 — drop laboratory destructure from controller; rip out laboratory branch from props builder (~80 lines mid-file).
- `apps/web/app/useReaderShellProps.ts:15, 99, 111` — same pattern; this file is ~570 lines and has more laboratory wiring throughout. Strip every `laboratory*` reference; the resulting hook returns the same shape minus the laboratory props.
- `apps/web/hooks/workspace/controller/createWorkspaceController.ts:3` — drop import of `./laboratory.ts`; remove the laboratory commands from the assembled controller.
- `apps/web/hooks/workspace/controller/types.ts:127, 131, 266` — remaining `LearningSection` references → `LessonNode`. Also **WorkspaceController** type may still surface laboratory commands in its return type via `createLaboratoryCommands` — drop those.
- `apps/web/hooks/workspace/useWorkspaceReaderActions.ts` — laboratory wiring, plus the section/lesson identity confusion (line 133)
- `apps/web/services/workspace/persistence.ts:4` — uses `laboratory` from WorkspaceDomainState; drop.
- `apps/web/utils/context/sourceMaterial.ts:3` — drops `LaboratoryExercise` import; the file has `getLaboratorySourcePageLabel` — likely delete the function entirely (it's only consumed by readerShellProps lines 13-16).

**Pattern C — `recentDevelopments` (PRE-EXISTING; NOT a Phase 1 issue):**
- `apps/web/services/projects/projectSnapshot.ts(402,3)` — exists on `main`, ignore.

## Remaining work — tests (~200 errors across ~14 test files)

Test fixtures all need to switch from `learningPlan: { sections: [...] }` to `learningPlan: { modules: [...], applicationExercisePlanningStatus: 'not-run' }` and stamp `kind: 'lesson'` on every lesson literal. Snapshot fixtures need to drop `laboratory: ...` and `activeLaboratoryExerciseId`.

Top offenders:
- `apps/web/tests/hooks/workspace/useWorkspaceController.test.ts` — 79 errors, biggest cluster
- `apps/web/tests/services/openrouter/documentIndex.test.ts` — 38
- `apps/web/tests/services/workspace/controller/snapshotHydration.test.ts` — 12 (the 3 tests I wrote should pass; the existing 12 errors are old fixtures)
- `apps/web/tests/services/projects/projectSnapshot.test.ts` — 11
- `apps/web/tests/services/workspace/domain.test.ts` — 9
- `apps/web/tests/services/projects/projectTransfer.test.ts` — 8
- `apps/web/tests/services/library/toolExecutor.test.ts` — 8
- `apps/web/tests/utils/pdf/projectHydration.test.ts` — 7
- `apps/web/tests/utils/reader/workspaceReader.test.ts` — 4
- `apps/web/tests/hooks/library/useProjectLibrary.test.ts` — 4
- `apps/web/tests/hooks/library/useProjectLibrary.dom.test.tsx` — 4
- `apps/web/tests/utils/learning/lessonGenerationState.test.ts` — 3
- `apps/web/tests/utils/learning/artifacts.test.ts` — 3
- `apps/web/tests/hooks/library/useLibraryAssistantChat.test.tsx` — 3

A small mechanical helper would help: a fixture builder `buildPlanFromLessons(lessons: LessonInput[]): LearningPlan` that wraps lessons in a single module with `applicationExercisePlanningStatus: 'not-run'`. Then most test fixtures become 1-2 lines instead of 5+.

## Remaining Phase 1 plan tasks not yet done

- T8 — sectionTree + lessonGenerationState (sectionTree DONE via rename; `lessonGenerationState.ts` still has 1 sections ref — see Pattern A list)
- T9 — reader/learn-mode/research/etc. (mostly DONE; remnants in Pattern A list)
- T10 — sidebar renders modules + stub exercise rows (NOT STARTED; needs WorkspaceReaderSidebar.tsx rewrite per plan Task 10)
- T11 — drop laboratory wiring from `readerShellProps`, `createWorkspaceController` (NOT STARTED, see Pattern B)
- T13 partial — `SavedProjectMeta` computation done; SavedProjectMeta-test pending
- T14 — full quality + test gate (NOT STARTED)
- T15 — graphify update (NOT STARTED — runs after gate is green)

## Recommended order for next session

1. **Pattern A** sweep — quick wins, ~12 single-line edits across 9 files. ~15 tool calls.
2. **Pattern B** — shell teardown. Start with `shell/types.ts` (interface trimming), then `readerShellProps.ts`, then `useReaderShellProps.ts`, then `WorkspaceReaderContent.tsx`, then the `controller/createWorkspaceController.ts` and `controller/types.ts`. ~40 tool calls; each `useReaderShellProps` and `readerShellProps` rewrite is the bulk of the work.
3. **Sidebar T10** — rewrite `WorkspaceReaderSidebar.tsx` per plan Task 10 (ModuleGroup + SidebarLessonRow + SidebarExerciseRowStub). ~5-10 tool calls.
4. **Tests** — start with the fixture builder helper, then sweep the test files top-down. ~40-60 tool calls.
5. **Gate** — `bun run quality && bun run gate`. Fix any stragglers.
6. **graphify update**.

Estimate: 100-130 tool calls to ship Phase 1.
