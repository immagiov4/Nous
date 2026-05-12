# Application Exercises — Phase 1: Data Model + Migration + Laboratory Removal

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reshape `LearningPlan` to use modules-as-containers with discriminated `LessonNode | ApplicationExerciseNode` children, migrate old snapshots, and hard-delete the legacy Laboratory subsystem. Phase 1 ships a compileable, test-green app with the new schema in place but no exercise-generation features yet (those come in Phases 2–5).

**Architecture:**
- Big-bang schema swap. `LearningPlan.sections` → `LearningPlan.modules`. `LearningSection` → `LessonNode`. New types: `LearningModule`, `ApplicationExerciseNode`, `ExerciseAttachment`, `ExerciseFeedback`. All laboratory code, types, components, services, and tests deleted in this phase.
- Migration is a pure function `groupSectionsIntoModules` consumed by both `prepareSnapshotForHydration` (legacy snapshots) and the OpenRouter planner (new courses). Same function = one truth source for grouping.
- Centralized constants in `apps/web/services/exercises/constants.ts`.

**Tech Stack:** TypeScript, vitest (run via `bun --bun vitest`), zustand, IndexedDB (idb), React, Biome, OpenRouter (no AI changes in Phase 1).

**Spec reference:** [docs/superpowers/specs/2026-05-08-application-exercises-design.md](../specs/2026-05-08-application-exercises-design.md).

---

## File structure for Phase 1

**Create:**
- `apps/web/services/exercises/constants.ts` — centralized numeric/set constants.
- `apps/web/services/learning/groupSectionsIntoModules.ts` — pure migrator, used by hydration + planner.
- `apps/web/tests/services/exercises/constants.test.ts`
- `apps/web/tests/services/learning/groupSectionsIntoModules.test.ts`

**Modify (substantive type changes):**
- `apps/web/types.ts` — types.
- `apps/web/services/workspace/controller/snapshotHydration.ts` — migration + drop laboratory.
- `apps/web/services/openrouter/planning/planner.ts` — emit modules.
- `apps/web/components/workspace/shell/WorkspaceReaderSidebar.tsx` — render modules + drop laboratory section.
- `apps/web/app/readerShellProps.ts` — drop laboratory wiring.
- `apps/web/services/projects/projectSnapshot.ts` — saved meta computation, drop laboratory.

**Modify (mechanical: walk modules instead of sections):**
- `apps/web/utils/learning/sectionTree.ts`
- `apps/web/utils/learning/lessonGenerationState.ts`
- `apps/web/utils/reader/workspaceReader.ts`
- `apps/web/utils/library/assistant.ts`
- `apps/web/services/workspace/controller/learnMode.ts`
- `apps/web/services/openrouter/research.ts`
- `apps/web/services/openrouter/planning/metadata.ts`
- `apps/web/hooks/workspace/controller/sectionProgression.ts`
- (any other file flagged by the type checker after the schema swap)

**Delete:**
- `apps/web/services/openrouter/laboratory.ts`
- `apps/web/services/laboratory/` (entire directory)
- `apps/web/components/workspace/laboratory/` (entire directory)
- `apps/web/tests/services/openrouter/laboratory.test.ts`
- `apps/web/tests/utils/laboratoryFileFilter.test.ts`

---

## Conventions for this plan

- All shell commands assume the worktree root is the working directory: `c:\Users\giovb\dyad-apps\Lumina-Reader\.claude\worktrees\application-exercises-refactor`. Don't `cd` away from it. PowerShell is the system shell; commands written with bash semantics here can be run via the Bash tool.
- Run a single test file: `bun --bun vitest run --config apps/web/vitest.config.ts <relative-test-path>`.
- Run full quality gate: `bun run quality`.
- Run full test gate: `bun run test`.
- Commit message style: imperative, lowercase prefix (`feat:`, `refactor:`, `chore:`). Each commit is a single logical change.

---

## Task 1: Centralized exercise constants

**Files:**
- Create: `apps/web/services/exercises/constants.ts`
- Test:   `apps/web/tests/services/exercises/constants.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/services/exercises/constants.test.ts
import { describe, expect, it } from 'vitest';
import {
  EXERCISE_PASS_THRESHOLD,
  EXERCISE_MAX_ENTRIES,
  EXERCISE_MAX_TOTAL_CHARS,
  EXERCISE_MAX_ENTRY_CHARS,
  EXERCISE_TEXT_EXTENSION_ALLOWLIST,
  EXERCISE_ZIP_IGNORE_DIRS,
} from '../../../services/exercises/constants.ts';

describe('exercise constants', () => {
  it('threshold defaults to 60', () => {
    expect(EXERCISE_PASS_THRESHOLD).toBe(60);
  });

  it('budget constants match spec', () => {
    expect(EXERCISE_MAX_ENTRIES).toBe(10);
    expect(EXERCISE_MAX_TOTAL_CHARS).toBe(50_000);
    expect(EXERCISE_MAX_ENTRY_CHARS).toBe(20_000);
  });

  it('text allowlist includes core text formats and code extensions', () => {
    for (const ext of ['.md', '.txt', '.json', '.ts', '.tsx', '.py', '.go']) {
      expect(EXERCISE_TEXT_EXTENSION_ALLOWLIST.has(ext)).toBe(true);
    }
    expect(EXERCISE_TEXT_EXTENSION_ALLOWLIST.has('.png')).toBe(false);
  });

  it('zip ignore set covers common build/cache dirs', () => {
    for (const dir of ['node_modules', 'dist', 'build', 'target', '.next', '.cache', 'coverage', '__pycache__']) {
      expect(EXERCISE_ZIP_IGNORE_DIRS.has(dir)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun --bun vitest run --config apps/web/vitest.config.ts apps/web/tests/services/exercises/constants.test.ts
```
Expected: FAIL — `Cannot find module '../../../services/exercises/constants.ts'`.

- [ ] **Step 3: Implement constants**

```ts
// apps/web/services/exercises/constants.ts
export const EXERCISE_PASS_THRESHOLD = 60;
export const EXERCISE_MAX_ENTRIES = 10;
export const EXERCISE_MAX_TOTAL_CHARS = 50_000;
export const EXERCISE_MAX_ENTRY_CHARS = 20_000;

export const EXERCISE_TEXT_EXTENSION_ALLOWLIST: ReadonlySet<string> = new Set([
  '.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.csv', '.tsv',
  '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java',
  '.c', '.cpp', '.h', '.css', '.scss', '.html',
]);

export const EXERCISE_ZIP_IGNORE_DIRS: ReadonlySet<string> = new Set([
  'node_modules', 'dist', 'build', 'target', '.next', '.cache', 'coverage', '__pycache__',
]);
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun --bun vitest run --config apps/web/vitest.config.ts apps/web/tests/services/exercises/constants.test.ts
```
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add apps/web/services/exercises/constants.ts apps/web/tests/services/exercises/constants.test.ts
git commit -m "feat(exercises): add centralized constants for thresholds and budgets"
```

---

## Task 2: Add new application-exercise + module types

These are purely additive in this task — `LearningSection` and `LearningPlan.sections` still exist. The big swap happens in Task 5.

**Files:**
- Modify: `apps/web/types.ts` (append new types after the existing `LearningPlan` block, around line 340 onwards)

- [ ] **Step 1: Add the new types to `types.ts`**

Append (after the existing `LaboratoryState` block, replacing nothing — the laboratory types stay until Task 7):

```ts
// === Application exercises (new path nodes) ===

export type ExerciseAttachmentKind = 'archive' | 'text';

export interface ExerciseAttachment {
  id: string;
  name: string;
  mimeType: string;
  kind: ExerciseAttachmentKind;
  data: string; // plain text for kind='text'; base64 for kind='archive'
  description?: string;
  truncated: boolean;
  truncatedReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExerciseFeedback {
  evaluatedAt: string;
  score: number;
  qualitativeLabel: string;
  summary: string;
  strengths: string[];
  improvements: string[];
  caveats: string[];
  verifiedSources?: ResearchSourceReference[];
}

export interface ApplicationExerciseNode {
  kind: 'exercise';
  id: string;
  title: string;
  description: string;
  assessedObjective: string;
  brief?: string;
  internalText?: string;
  attachments: ExerciseAttachment[];
  currentFeedback: ExerciseFeedback | null;
  bestScore?: number;
  completedAt?: string;
  isCompleted: boolean;
  feedbackStale: boolean;
  groundingSources?: ResearchSourceReference[];
  generatedAt?: string;
  updatedAt: string;
}

export interface LessonNode extends Omit<LearningSection, 'moduleTitle'> {
  kind: 'lesson';
}

export type PathNode = LessonNode | ApplicationExerciseNode;

export interface LearningModule {
  id: string;
  title: string;
  description?: string;
  type?: 'prerequisite' | 'core' | 'summary' | 'deep-dive';
  children: PathNode[];
}

export type ApplicationExercisePlanningStatus = 'not-run' | 'completed' | 'failed';

export interface ApplicationExercisePlanningError {
  message: string;
  attempts: number;
  lastAttemptAt: string;
}
```

- [ ] **Step 2: Type-check**

```bash
bun run lint:types
```
Expected: PASS. The new types reference only existing exports (`LearningSection`, `ResearchSourceReference`).

- [ ] **Step 3: Commit**

```bash
git add apps/web/types.ts
git commit -m "feat(types): add ApplicationExerciseNode, LearningModule, PathNode shapes"
```

---

## Task 3: Build `groupSectionsIntoModules` (TDD)

Pure function consumed by both `prepareSnapshotForHydration` and the planner. Group consecutive `LearningSection`s by `moduleTitle`, generate stable IDs from `(position, slug(title))`, derive module type when uniform.

**Files:**
- Create: `apps/web/services/learning/groupSectionsIntoModules.ts`
- Test:   `apps/web/tests/services/learning/groupSectionsIntoModules.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/tests/services/learning/groupSectionsIntoModules.test.ts
import { describe, expect, it } from 'vitest';
import { groupSectionsIntoModules } from '../../../services/learning/groupSectionsIntoModules.ts';
import type { LearningSection } from '../../../types.ts';

const section = (id: string, overrides: Partial<LearningSection> = {}): LearningSection => ({
  id,
  title: `Lesson ${id}`,
  description: '',
  isCompleted: false,
  type: 'core',
  ...overrides,
});

describe('groupSectionsIntoModules', () => {
  it('returns empty modules for empty input', () => {
    expect(groupSectionsIntoModules([])).toEqual([]);
  });

  it('places no-moduleTitle sections in a single Untitled module', () => {
    const result = groupSectionsIntoModules([section('a'), section('b')]);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Untitled module');
    expect(result[0].children).toHaveLength(2);
    expect(result[0].children[0].kind).toBe('lesson');
  });

  it('groups consecutive sections sharing moduleTitle', () => {
    const result = groupSectionsIntoModules([
      section('a', { moduleTitle: 'Foundations' }),
      section('b', { moduleTitle: 'Foundations' }),
      section('c', { moduleTitle: 'Applications' }),
    ]);
    expect(result.map(m => m.title)).toEqual(['Foundations', 'Applications']);
    expect(result[0].children).toHaveLength(2);
    expect(result[1].children).toHaveLength(1);
  });

  it('starts a new module when moduleTitle changes back', () => {
    const result = groupSectionsIntoModules([
      section('a', { moduleTitle: 'A' }),
      section('b', { moduleTitle: 'B' }),
      section('c', { moduleTitle: 'A' }),
    ]);
    expect(result.map(m => m.title)).toEqual(['A', 'B', 'A']);
    expect(result.map(m => m.id)).toHaveLength(3);
    expect(new Set(result.map(m => m.id)).size).toBe(3); // unique despite duplicate title
  });

  it('preserves parentId sub-chapters within their parent module', () => {
    const result = groupSectionsIntoModules([
      section('parent', { moduleTitle: 'M' }),
      section('child', { moduleTitle: 'M', parentId: 'parent' }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].children).toHaveLength(2);
    const child = result[0].children[1];
    expect(child.kind).toBe('lesson');
    if (child.kind === 'lesson') {
      expect(child.parentId).toBe('parent');
    }
  });

  it('produces stable IDs across repeat calls on identical input', () => {
    const sections = [section('a', { moduleTitle: 'M' }), section('b', { moduleTitle: 'N' })];
    const first = groupSectionsIntoModules(sections);
    const second = groupSectionsIntoModules(sections);
    expect(first.map(m => m.id)).toEqual(second.map(m => m.id));
  });

  it('derives module type when all children share the same LearningSection.type', () => {
    const result = groupSectionsIntoModules([
      section('a', { moduleTitle: 'Intro', type: 'prerequisite' }),
      section('b', { moduleTitle: 'Intro', type: 'prerequisite' }),
      section('c', { moduleTitle: 'Body', type: 'core' }),
      section('d', { moduleTitle: 'Body', type: 'summary' }),
    ]);
    expect(result[0].type).toBe('prerequisite');
    expect(result[1].type).toBeUndefined(); // mixed types → no derived module type
  });

  it('strips moduleTitle off the LessonNode children and stamps kind=lesson', () => {
    const result = groupSectionsIntoModules([section('a', { moduleTitle: 'M' })]);
    const child = result[0].children[0];
    expect(child.kind).toBe('lesson');
    expect((child as Record<string, unknown>).moduleTitle).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun --bun vitest run --config apps/web/vitest.config.ts apps/web/tests/services/learning/groupSectionsIntoModules.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the migrator**

```ts
// apps/web/services/learning/groupSectionsIntoModules.ts
import type {
  LearningModule,
  LearningSection,
  LessonNode,
  PathNode,
} from '../../types.ts';

const UNTITLED = 'Untitled module';

const slugify = (input: string): string =>
  input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'untitled';

const sectionToLessonNode = (section: LearningSection): LessonNode => {
  const { moduleTitle: _moduleTitle, ...rest } = section;
  return { kind: 'lesson', ...rest };
};

const deriveModuleType = (children: PathNode[]): LearningModule['type'] => {
  const types = new Set<string>();
  for (const child of children) {
    if (child.kind === 'lesson') {
      types.add(child.type);
    }
  }
  if (types.size !== 1) {
    return undefined;
  }
  return [...types][0] as LearningModule['type'];
};

export const groupSectionsIntoModules = (sections: LearningSection[]): LearningModule[] => {
  if (sections.length === 0) {
    return [];
  }

  const modules: LearningModule[] = [];
  let currentTitle: string | null = null;
  let currentChildren: PathNode[] = [];

  const flush = () => {
    if (currentChildren.length === 0) {
      return;
    }
    const title = currentTitle && currentTitle.trim().length > 0 ? currentTitle : UNTITLED;
    const position = modules.length;
    const id = `m-${position}-${slugify(title)}`;
    modules.push({
      id,
      title,
      children: currentChildren,
      type: deriveModuleType(currentChildren),
    });
    currentChildren = [];
  };

  for (const section of sections) {
    const sectionTitle = (section.moduleTitle ?? '').trim() || null;
    if (sectionTitle !== currentTitle && currentChildren.length > 0) {
      flush();
    }
    currentTitle = sectionTitle;
    currentChildren.push(sectionToLessonNode(section));
  }
  flush();

  return modules;
};
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun --bun vitest run --config apps/web/vitest.config.ts apps/web/tests/services/learning/groupSectionsIntoModules.test.ts
```
Expected: PASS (8/8).

- [ ] **Step 5: Commit**

```bash
git add apps/web/services/learning/groupSectionsIntoModules.ts apps/web/tests/services/learning/groupSectionsIntoModules.test.ts
git commit -m "feat(learning): add groupSectionsIntoModules migrator"
```

---

## Task 4: Update LearningPlan, ProjectSnapshot, SavedProjectMeta types

This task is the **schema swap**. After this commit, every consumer that reads `learningPlan.sections` will be a type error. Tasks 5–13 progressively fix consumers.

**Files:**
- Modify: `apps/web/types.ts`

- [ ] **Step 1: Edit `LearningPlan`**

Replace the existing `LearningPlan` interface (around line 333):

```ts
export interface LearningPlan {
  title: string;
  summary: string;
  modules: LearningModule[];
  applicationExercisePlanningStatus: ApplicationExercisePlanningStatus;
  applicationExercisePlanningNotes?: string;
  applicationExercisePlanningError?: ApplicationExercisePlanningError;
  backgroundMusicUrl?: string;
  generationNotes?: string;
}
```

- [ ] **Step 2: Edit `ProjectSnapshot`**

Replace the existing `ProjectSnapshot` interface (around line 407). Drop `laboratory` and `activeLaboratoryExerciseId`:

```ts
export interface ProjectSnapshot {
  id: ProjectId;
  version: string;
  sourceKind: ProjectSourceKind;
  state: AppState;
  source: ProjectSource | null;
  learningPlan: LearningPlan | null;
  isLearnMode: boolean;
  userProfile: UserProfile | null;
  syllabus: SyllabusItem[];
  researchCoursePlan?: ResearchCoursePlan | null;
  researchDossiersBySectionId?: ResearchDossiersBySectionId;
  activeSectionId: string | null;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  documentAssets?: PdfDocumentAssets | null;
  documentIndex?: PdfTextIndex | null;
}
```

- [ ] **Step 3: Edit `ProjectExportData`**

Drop `laboratory` and `activeLaboratoryExerciseId` (around line 429+):

```ts
export interface ProjectExportData {
  id?: ProjectId;
  version: string;
  state?: AppState;
  file?: FileData | null;
  source?: ProjectSource | null;
  learningPlan: LearningPlan | null;
  isLearnMode: boolean;
  userProfile: UserProfile | null;
  syllabus: SyllabusItem[];
  researchCoursePlan?: ResearchCoursePlan | null;
  researchDossiersBySectionId?: ResearchDossiersBySectionId;
  activeSectionId?: string | null;
  // ...keep any remaining fields below as they were
}
```
(If other fields exist below `activeSectionId`, leave them untouched. Only remove `laboratory` and `activeLaboratoryExerciseId`.)

- [ ] **Step 4: Edit `SavedProjectMeta`**

Add the two new fields:

```ts
export interface SavedProjectMeta {
  id: ProjectId;
  title: string;
  sourceKind: ProjectSourceKind;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  lessonCount: number;
  completedCount: number;
  exerciseCount: number;
  completedExercises: number;
  hasSourceFile: boolean;
  coverLabel: string;
  syncState: ProjectSyncState;
}
```

- [ ] **Step 5: Type-check (expect cascade of errors)**

```bash
bun run lint:types
```
Expected: FAIL with many errors. **Do not fix them yet.** This is the inflection point. Capture the list of failing files for use in Task 5.

```bash
bun run lint:types 2>&1 | grep -E "error TS" | awk '{print $1}' | sort -u
```

- [ ] **Step 6: Commit (broken state — annotated)**

```bash
git add apps/web/types.ts
git commit -m "refactor(types): swap LearningPlan to modules, drop laboratory from snapshot

This commit intentionally leaves the build broken. Subsequent tasks
fix consumers one at a time."
```

---

## Task 5: Update planner to emit modules

The planner currently emits `{ sections, ... }` with `moduleTitle` strings. Reuse `groupSectionsIntoModules` to wrap its output.

**Files:**
- Modify: `apps/web/services/openrouter/planning/planner.ts`

- [ ] **Step 1: Read the planner output assembly**

```bash
bun --bun vitest --config apps/web/vitest.config.ts list 2>/dev/null | head -1   # discovers config sanity
```
Then read the file end-to-end (approx 200 lines):

```bash
sed -n '1,220p' apps/web/services/openrouter/planning/planner.ts
```

Locate the function that returns `{ sections: dedupedSections, ... }` (around line 75).

- [ ] **Step 2: Apply the change**

At the return site, wrap the deduped sections:

```ts
import { groupSectionsIntoModules } from '../../learning/groupSectionsIntoModules.ts';

// ...inside normalizeLearningPlan or equivalent:
return {
  title,
  summary,
  modules: groupSectionsIntoModules(dedupedSections),
  applicationExercisePlanningStatus: 'not-run',
  generationNotes,                       // keep existing
  backgroundMusicUrl,                    // keep existing
};
```

If the function used to return `LearningPlan` from sections internally normalized as `LearningSection[]`, those internal helpers stay — only the final return shape changes.

- [ ] **Step 3: Run planner tests**

```bash
bun --bun vitest run --config apps/web/vitest.config.ts apps/web/tests/services/openrouter/planning.test.ts
```
Expected: most assertions failing because tests reference `plan.sections`. **For Task 5, only fix tests that block the unit tests of `normalizeLearningPlan` itself**: rewrite each `expect(plan.sections...)` to walk `plan.modules.flatMap(m => m.children).filter(c => c.kind === 'lesson')`.

(Tests for downstream consumers stay broken until those consumers are fixed.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/services/openrouter/planning/planner.ts apps/web/tests/services/openrouter/planning.test.ts
git commit -m "refactor(planner): emit LearningPlan with modules instead of flat sections"
```

---

## Task 6: Add a path-walk helper

Most consumers want "all lessons in path order". Avoid copy-paste by exposing one helper.

**Files:**
- Create: `apps/web/utils/learning/pathNodes.ts`
- Test:   `apps/web/tests/utils/learning/pathNodes.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/utils/learning/pathNodes.test.ts
import { describe, expect, it } from 'vitest';
import {
  flattenPathNodes,
  flattenLessons,
  findPathNodeById,
} from '../../../utils/learning/pathNodes.ts';
import type { LearningPlan } from '../../../types.ts';

const plan = (): LearningPlan => ({
  title: 't',
  summary: '',
  applicationExercisePlanningStatus: 'not-run',
  modules: [
    {
      id: 'm0',
      title: 'A',
      children: [
        { kind: 'lesson', id: 'L1', title: 'L1', description: '', isCompleted: false, type: 'core' },
        { kind: 'lesson', id: 'L2', title: 'L2', description: '', isCompleted: false, type: 'core' },
      ],
    },
    {
      id: 'm1',
      title: 'B',
      children: [
        { kind: 'lesson', id: 'L3', title: 'L3', description: '', isCompleted: false, type: 'core' },
      ],
    },
  ],
});

describe('pathNodes helpers', () => {
  it('flattenPathNodes preserves module order', () => {
    expect(flattenPathNodes(plan()).map(n => n.id)).toEqual(['L1', 'L2', 'L3']);
  });

  it('flattenLessons returns only LessonNodes', () => {
    const lessons = flattenLessons(plan());
    expect(lessons.every(l => l.kind === 'lesson')).toBe(true);
    expect(lessons).toHaveLength(3);
  });

  it('findPathNodeById walks every module', () => {
    expect(findPathNodeById(plan(), 'L3')?.id).toBe('L3');
    expect(findPathNodeById(plan(), 'missing')).toBeNull();
  });

  it('handles a null plan', () => {
    expect(flattenPathNodes(null)).toEqual([]);
    expect(flattenLessons(null)).toEqual([]);
    expect(findPathNodeById(null, 'x')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test**

```bash
bun --bun vitest run --config apps/web/vitest.config.ts apps/web/tests/utils/learning/pathNodes.test.ts
```
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// apps/web/utils/learning/pathNodes.ts
import type { LearningPlan, LessonNode, PathNode } from '../../types.ts';

export const flattenPathNodes = (plan: LearningPlan | null): PathNode[] =>
  plan ? plan.modules.flatMap(m => m.children) : [];

export const flattenLessons = (plan: LearningPlan | null): LessonNode[] =>
  flattenPathNodes(plan).filter((n): n is LessonNode => n.kind === 'lesson');

export const findPathNodeById = (
  plan: LearningPlan | null,
  id: string | null | undefined
): PathNode | null => {
  if (!plan || !id) {
    return null;
  }
  for (const module of plan.modules) {
    for (const child of module.children) {
      if (child.id === id) {
        return child;
      }
    }
  }
  return null;
};
```

- [ ] **Step 4: Run test to verify pass**

```bash
bun --bun vitest run --config apps/web/vitest.config.ts apps/web/tests/utils/learning/pathNodes.test.ts
```
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add apps/web/utils/learning/pathNodes.ts apps/web/tests/utils/learning/pathNodes.test.ts
git commit -m "feat(learning): add pathNodes helper for walking modules"
```

---

## Task 7: Update `prepareSnapshotForHydration` (TDD)

Migrate legacy `learningPlan.sections` → `modules`, drop `laboratory`, default planning status to `'not-run'`.

**Files:**
- Modify: `apps/web/services/workspace/controller/snapshotHydration.ts`
- Test:   `apps/web/tests/services/workspace/controller/snapshotHydration.test.ts` (create if missing)

- [ ] **Step 1: Write the failing tests**

Check whether the test file exists:

```bash
ls apps/web/tests/services/workspace/controller/snapshotHydration.test.ts 2>/dev/null
```

If it doesn't, create it. Write the tests:

```ts
// apps/web/tests/services/workspace/controller/snapshotHydration.test.ts
import { describe, expect, it } from 'vitest';
import { prepareSnapshotForHydration } from '../../../../services/workspace/controller/snapshotHydration.ts';
import type { ProjectSnapshot } from '../../../../types.ts';
import { AppState } from '../../../../types.ts';

const baseSnapshot = (): ProjectSnapshot => ({
  id: 'p1' as ProjectSnapshot['id'],
  version: '1',
  sourceKind: 'pdf',
  state: AppState.READING,
  source: null,
  learningPlan: null,
  isLearnMode: false,
  userProfile: null,
  syllabus: [],
  activeSectionId: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  lastOpenedAt: '2026-01-01T00:00:00Z',
});

describe('prepareSnapshotForHydration', () => {
  it('migrates legacy sections to modules', () => {
    const legacy = {
      ...baseSnapshot(),
      learningPlan: {
        title: 'T',
        summary: '',
        // simulate legacy persisted shape
        sections: [
          { id: 's1', title: 'S1', description: '', isCompleted: false, type: 'core', moduleTitle: 'A' },
          { id: 's2', title: 'S2', description: '', isCompleted: false, type: 'core', moduleTitle: 'A' },
          { id: 's3', title: 'S3', description: '', isCompleted: false, type: 'core', moduleTitle: 'B' },
        ],
      },
    } as unknown as ProjectSnapshot;

    const result = prepareSnapshotForHydration(legacy);
    expect(result.learningPlan?.modules).toHaveLength(2);
    expect(result.learningPlan?.modules[0].title).toBe('A');
    expect(result.learningPlan?.modules[1].title).toBe('B');
    expect(result.learningPlan?.applicationExercisePlanningStatus).toBe('not-run');
  });

  it('drops a legacy laboratory field silently', () => {
    const legacy = {
      ...baseSnapshot(),
      laboratory: { exercises: [], status: 'idle', schemaVersion: 2, summary: '', title: '', updatedAt: '' },
      activeLaboratoryExerciseId: 'whatever',
    } as unknown as ProjectSnapshot;
    const result = prepareSnapshotForHydration(legacy);
    expect((result as unknown as Record<string, unknown>).laboratory).toBeUndefined();
    expect((result as unknown as Record<string, unknown>).activeLaboratoryExerciseId).toBeUndefined();
  });

  it('preserves a snapshot already in the new shape', () => {
    const fresh: ProjectSnapshot = {
      ...baseSnapshot(),
      learningPlan: {
        title: 'T',
        summary: '',
        applicationExercisePlanningStatus: 'completed',
        modules: [
          {
            id: 'm0',
            title: 'A',
            children: [
              { kind: 'lesson', id: 's1', title: 'S1', description: '', isCompleted: false, type: 'core' },
            ],
          },
        ],
      },
    };
    const result = prepareSnapshotForHydration(fresh);
    expect(result.learningPlan?.modules).toHaveLength(1);
    expect(result.learningPlan?.applicationExercisePlanningStatus).toBe('completed');
  });
});
```

- [ ] **Step 2: Run tests**

```bash
bun --bun vitest run --config apps/web/vitest.config.ts apps/web/tests/services/workspace/controller/snapshotHydration.test.ts
```
Expected: FAIL — current implementation references `snapshot.laboratory` and reads `learningPlan.sections`.

- [ ] **Step 3: Rewrite `snapshotHydration.ts`**

Full file contents (replace existing 127 lines):

```ts
// apps/web/services/workspace/controller/snapshotHydration.ts
import {
  AppState,
  type LearningPlan,
  type LearningSection,
  type LessonNode,
  type ProjectSnapshot,
} from '../../../types.ts';
import { migrateSectionAnnotations } from '../../../utils/learning/sectionAnnotations.ts';
import { normalizeMarkdownForRendering } from '../../../utils/markdown/render.ts';
import { restoreLegacyPdfImagePlaceholders } from '../../../utils/pdf/imagePlaceholders.ts';
import { pushNousDebugTrace } from '../../core/debugTrace.ts';
import { groupSectionsIntoModules } from '../../learning/groupSectionsIntoModules.ts';
import { flattenLessons, findPathNodeById } from '../../../utils/learning/pathNodes.ts';

const HYDRATION_TRACE_PREVIEW_CHARS = 1600;

const summarizeHydratedContent = (content: string) => ({
  hasCodeFence: /(^|\n)```/.test(content),
  length: content.length,
  preview: content.slice(0, HYDRATION_TRACE_PREVIEW_CHARS),
});

const migrateLegacyPlanShape = (raw: unknown): LearningPlan | null => {
  if (!raw || typeof raw !== 'object') return null;
  const plan = raw as Record<string, unknown>;
  if (Array.isArray(plan.modules)) {
    // Already new-shape; ensure the planning status field exists.
    return {
      title: String(plan.title ?? ''),
      summary: String(plan.summary ?? ''),
      modules: plan.modules as LearningPlan['modules'],
      applicationExercisePlanningStatus:
        (plan.applicationExercisePlanningStatus as LearningPlan['applicationExercisePlanningStatus']) ?? 'not-run',
      applicationExercisePlanningNotes: plan.applicationExercisePlanningNotes as string | undefined,
      applicationExercisePlanningError:
        plan.applicationExercisePlanningError as LearningPlan['applicationExercisePlanningError'],
      backgroundMusicUrl: plan.backgroundMusicUrl as string | undefined,
      generationNotes: plan.generationNotes as string | undefined,
    };
  }
  if (Array.isArray(plan.sections)) {
    const sections = plan.sections as LearningSection[];
    return {
      title: String(plan.title ?? ''),
      summary: String(plan.summary ?? ''),
      modules: groupSectionsIntoModules(sections),
      applicationExercisePlanningStatus: 'not-run',
      backgroundMusicUrl: plan.backgroundMusicUrl as string | undefined,
      generationNotes: plan.generationNotes as string | undefined,
    };
  }
  return null;
};

const normalizeLessonContent = (lesson: LessonNode): LessonNode => {
  if (!lesson.content) {
    return lesson;
  }
  const normalizedContent = normalizeMarkdownForRendering(
    restoreLegacyPdfImagePlaceholders(lesson.content)
  );
  const migrated = migrateSectionAnnotations({
    annotations: lesson.annotations,
    content: normalizedContent,
  });
  if (!migrated.didChange && normalizedContent === lesson.content) {
    return lesson;
  }
  return { ...lesson, content: migrated.content, annotations: migrated.annotations };
};

const normalizeLearningPlanContent = (plan: LearningPlan | null): LearningPlan | null => {
  if (!plan) return null;
  let didChange = false;
  const modules = plan.modules.map(module => {
    let moduleChanged = false;
    const children = module.children.map(child => {
      if (child.kind !== 'lesson') return child;
      const next = normalizeLessonContent(child);
      if (next !== child) moduleChanged = true;
      return next;
    });
    if (!moduleChanged) return module;
    didChange = true;
    return { ...module, children };
  });
  return didChange ? { ...plan, modules } : plan;
};

export const resolvePlanLesson = (
  learningPlan: LearningPlan | null,
  activeSectionId?: string | null
): LessonNode | null => {
  if (!learningPlan) return null;
  if (activeSectionId) {
    const explicit = findPathNodeById(learningPlan, activeSectionId);
    if (explicit?.kind === 'lesson') return explicit;
  }
  const lessons = flattenLessons(learningPlan);
  return lessons.find(l => !l.isCompleted) ?? lessons[0] ?? null;
};

export const resolveScreenStateForSnapshot = (
  snapshot: Pick<ProjectSnapshot, 'learningPlan' | 'source'>
): AppState => {
  if (snapshot.learningPlan) return AppState.READING;
  if (snapshot.source) return AppState.ASSESSMENT;
  return AppState.LIBRARY;
};

export const prepareSnapshotForHydration = (snapshot: ProjectSnapshot): ProjectSnapshot => {
  const migratedPlan = migrateLegacyPlanShape(snapshot.learningPlan as unknown);
  const normalizedPlan = normalizeLearningPlanContent(migratedPlan);

  if ((snapshot as unknown as Record<string, unknown>).laboratory) {
    pushNousDebugTrace('snapshot-hydration:dropped-legacy-laboratory', {});
  }

  const activeLesson = resolvePlanLesson(normalizedPlan, snapshot.activeSectionId);
  if (activeLesson?.content) {
    pushNousDebugTrace('snapshot-hydration:active-section', {
      sectionId: activeLesson.id,
      sectionTitle: activeLesson.title,
      ...summarizeHydratedContent(activeLesson.content),
    });
  }

  // Strip laboratory + activeLaboratoryExerciseId from any legacy field.
  const { laboratory: _l, activeLaboratoryExerciseId: _a, ...rest } =
    snapshot as unknown as Record<string, unknown>;

  return {
    ...(rest as ProjectSnapshot),
    learningPlan: normalizedPlan,
    activeSectionId: activeLesson?.id ?? null,
  };
};
```

Notes:
- The legacy `resolvePlanSection` is renamed to `resolvePlanLesson` (returns `LessonNode | null`). All callers must update to the new name in subsequent tasks.
- The destructuring at the bottom strips the optional legacy fields without TypeScript reading them off the new `ProjectSnapshot` interface (which no longer declares them).

- [ ] **Step 4: Run hydration tests**

```bash
bun --bun vitest run --config apps/web/vitest.config.ts apps/web/tests/services/workspace/controller/snapshotHydration.test.ts
```
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add apps/web/services/workspace/controller/snapshotHydration.ts apps/web/tests/services/workspace/controller/snapshotHydration.test.ts
git commit -m "refactor(hydration): migrate legacy sections to modules and drop laboratory"
```

---

## Task 8: Rewire `sectionTree.ts` and `lessonGenerationState.ts`

These are pure utilities that walk a flat `sections[]`. Switch them to walk `modules[]` via the new helpers.

**Files:**
- Modify: `apps/web/utils/learning/sectionTree.ts`
- Modify: `apps/web/utils/learning/lessonGenerationState.ts`
- Modify: `apps/web/tests/utils/learning/lessonGenerationState.test.ts`

- [ ] **Step 1: Read the current files**

```bash
cat apps/web/utils/learning/sectionTree.ts
cat apps/web/utils/learning/lessonGenerationState.ts
```

- [ ] **Step 2: Replace section iteration with `flattenLessons`**

In each file, every place that does `learningPlan.sections.map / .filter / .find / .forEach` becomes `flattenLessons(learningPlan).map / .filter / .find / .forEach`. Import:

```ts
import { flattenLessons } from './pathNodes.ts'; // adjust relative path per file location
```

The function APIs (`buildSectionTree`, `computeLessonGenerationState`, etc.) keep their existing signatures but now accept `LearningPlan` instead of `LearningSection[]` where appropriate. If a helper currently takes `sections: LearningSection[]`, change it to take `lessons: LessonNode[]` and have callers do `flattenLessons(plan)` at the call site. Inside the helper, treat `LessonNode` like the old `LearningSection` since `LessonNode extends Omit<LearningSection, 'moduleTitle'>` — every field still exists, just `moduleTitle` is gone.

- [ ] **Step 3: Update tests**

In `apps/web/tests/utils/learning/lessonGenerationState.test.ts`, every `LearningSection` literal becomes a `LessonNode` (add `kind: 'lesson'`, remove `moduleTitle`). Group them under a fake plan when needed:

```ts
const plan = (lessons: LessonNode[]): LearningPlan => ({
  title: '', summary: '', applicationExercisePlanningStatus: 'not-run',
  modules: [{ id: 'm', title: 'M', children: lessons }],
});
```

- [ ] **Step 4: Run tests**

```bash
bun --bun vitest run --config apps/web/vitest.config.ts apps/web/tests/utils/learning/lessonGenerationState.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/utils/learning/ apps/web/tests/utils/learning/
git commit -m "refactor(learning): walk modules in sectionTree + lessonGenerationState"
```

---

## Task 9: Rewire reader-related utilities and learn-mode

**Files:**
- Modify: `apps/web/utils/reader/workspaceReader.ts`
- Modify: `apps/web/utils/library/assistant.ts`
- Modify: `apps/web/services/workspace/controller/learnMode.ts`
- Modify: `apps/web/hooks/workspace/controller/sectionProgression.ts`
- Modify: `apps/web/services/openrouter/research.ts`
- Modify: `apps/web/services/openrouter/planning/metadata.ts`
- Tests for the above where they exist (e.g. `apps/web/tests/utils/reader/workspaceReader.test.ts`, `apps/web/tests/services/workspace/domain.test.ts`, `apps/web/tests/hooks/workspace/useWorkspaceController.test.ts`)

- [ ] **Step 1: Apply mechanical replacements**

In each file:
- Replace imports of `LearningSection` with `LessonNode` where the symbol referred to a lesson (i.e. nearly everywhere).
- Replace `learningPlan.sections` with `flattenLessons(learningPlan)` where the consumer wants lessons in path order.
- Where the consumer mutates `sections` to produce a new `LearningPlan`, use the helper:

```ts
import { flattenLessons } from '../../utils/learning/pathNodes.ts';

const updateLessons = (
  plan: LearningPlan,
  updater: (lesson: LessonNode) => LessonNode
): LearningPlan => ({
  ...plan,
  modules: plan.modules.map(m => ({
    ...m,
    children: m.children.map(c => (c.kind === 'lesson' ? updater(c) : c)),
  })),
});
```

Add this helper to `apps/web/utils/learning/pathNodes.ts` if you find more than one consumer needs it.

- [ ] **Step 2: Add `updateLessons` helper to `pathNodes.ts`**

Append:

```ts
export const updateLessons = (
  plan: LearningPlan,
  updater: (lesson: LessonNode) => LessonNode
): LearningPlan => ({
  ...plan,
  modules: plan.modules.map(m => ({
    ...m,
    children: m.children.map(c => (c.kind === 'lesson' ? updater(c) : c)),
  })),
});
```

Add a test:

```ts
// in apps/web/tests/utils/learning/pathNodes.test.ts
it('updateLessons applies the updater to every lesson and leaves modules intact', () => {
  const p = plan();
  const next = updateLessons(p, lesson => ({ ...lesson, isCompleted: true }));
  expect(flattenLessons(next).every(l => l.isCompleted)).toBe(true);
  expect(next.modules.length).toBe(p.modules.length);
});
```

- [ ] **Step 3: Run targeted tests**

```bash
bun --bun vitest run --config apps/web/vitest.config.ts apps/web/tests/utils/reader/workspaceReader.test.ts apps/web/tests/services/workspace/domain.test.ts apps/web/tests/utils/learning/pathNodes.test.ts
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/utils apps/web/services/workspace/controller/learnMode.ts apps/web/hooks/workspace/controller/sectionProgression.ts apps/web/services/openrouter/research.ts apps/web/services/openrouter/planning/metadata.ts apps/web/tests/
git commit -m "refactor(learning): walk modules across reader, learn-mode, research, planning metadata"
```

---

## Task 10: Update `WorkspaceReaderSidebar` to render modules

The sidebar today renders one flat list of sections plus a separate laboratory section. After this task, the sidebar renders modules with their children. ApplicationExerciseNode rendering is a minimal placeholder (one icon + title) — Phase 2 will give the viewer a real UI.

**Files:**
- Modify: `apps/web/components/workspace/shell/WorkspaceReaderSidebar.tsx`
- (Strip laboratory imports and render path entirely; we'll rewire `readerShellProps` in Task 11.)

- [ ] **Step 1: Read the current sidebar**

```bash
sed -n '1,200p' apps/web/components/workspace/shell/WorkspaceReaderSidebar.tsx
```

- [ ] **Step 2: Replace the sidebar's body**

Top-level loop becomes:

```tsx
{learningPlan.modules.map(module => (
  <ModuleGroup key={module.id} module={module}>
    {module.children.map(child =>
      child.kind === 'lesson' ? (
        <SidebarLessonRow
          key={child.id}
          lesson={child}
          isActive={child.id === activeSectionId}
          onSelect={() => onSelectSection(child.id)}
          onRegenerate={onRegenerateLessonContent}
        />
      ) : (
        <SidebarExerciseRowStub
          key={child.id}
          exercise={child}
          isActive={child.id === activeSectionId}
          onSelect={() => onSelectSection(child.id)}
        />
      )
    )}
  </ModuleGroup>
))}
```

Define `ModuleGroup` and `SidebarExerciseRowStub` in the same file at first (extract later if they grow):

```tsx
const ModuleGroup: React.FC<{ module: LearningModule; children: React.ReactNode }> = ({
  module, children,
}) => (
  <div className="reader-sidebar__module">
    <div className="reader-sidebar__module-title">{module.title}</div>
    {children}
  </div>
);

const SidebarExerciseRowStub: React.FC<{
  exercise: ApplicationExerciseNode;
  isActive: boolean;
  onSelect: () => void;
}> = ({ exercise, isActive, onSelect }) => (
  <button
    type="button"
    className={`reader-sidebar__exercise${isActive ? ' is-active' : ''}`}
    onClick={onSelect}
  >
    {/* TODO Phase 2: dedicated icon */}
    <span aria-hidden>★</span> {exercise.title}
  </button>
);
```

Existing `SidebarLessonRow` (or its inline equivalent) should already accept a `LessonNode`-shaped object since the only field it really used was `id`, `title`, `isCompleted`, `type`. Adjust the type annotation to `LessonNode`.

- [ ] **Step 3: Remove laboratory rendering**

Delete:
- The entire "Laboratorio" section list.
- The `getLaboratoryExerciseStatusLabel` import + helper if it lives in this file.
- The "genera laboratorio" button.
- Any `onGenerateLaboratory`, `onSelectLaboratoryExercise`, `onRegenerateLaboratoryIndex` props from the component's props interface.

- [ ] **Step 4: Type-check**

```bash
bun run lint:frontend
```
Expected: errors limited to consumers of the props you removed (caught in Task 11).

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/workspace/shell/WorkspaceReaderSidebar.tsx
git commit -m "refactor(sidebar): render modules + lessons; stub exercise rows; drop laboratory"
```

---

## Task 11: Drop laboratory wiring from `readerShellProps` and friends

**Files:**
- Modify: `apps/web/app/readerShellProps.ts`
- Modify: `apps/web/hooks/workspace/controller/createWorkspaceController.ts` (this is the controller assembly)
- Modify: any other component that passed laboratory props down

- [ ] **Step 1: Find every laboratory reference**

Use the Grep tool with pattern `onGenerateLaboratory|onEvaluateExercise|laboratoryExercises|activeLaboratoryExerciseId|LaboratoryState|LaboratoryExercise|onRegenerateLaboratoryIndex` over `apps/web/**/*.{ts,tsx}` excluding `tests/`. Equivalent shell:

```bash
rg -n --type ts --type tsx -g '!apps/web/tests/**' \
  'onGenerateLaboratory|onEvaluateExercise|laboratoryExercises|activeLaboratoryExerciseId|LaboratoryState|LaboratoryExercise|onRegenerateLaboratoryIndex' \
  apps/web
```

- [ ] **Step 2: Delete every match outside `services/laboratory/` and `components/.../laboratory/`**

For each file:
- Remove the import.
- Remove the prop from the props interface.
- Remove the field from the object literal that returns `readerShellProps`.
- Remove the call site that invokes `generateLaboratory`/`evaluateLaboratoryExercise`.

- [ ] **Step 3: Type-check**

```bash
bun run lint:types
```
Expected: errors only inside `services/laboratory/` and `components/.../laboratory/` directories — those are deleted in Task 12.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app apps/web/hooks apps/web/components
git commit -m "refactor(workspace): unwire laboratory props from controller and shell"
```

---

## Task 12: Delete laboratory code

**Files (all deleted):**
- `apps/web/services/openrouter/laboratory.ts`
- `apps/web/services/laboratory/` (entire tree)
- `apps/web/components/workspace/laboratory/` (entire tree)
- `apps/web/tests/services/openrouter/laboratory.test.ts`
- `apps/web/tests/utils/laboratoryFileFilter.test.ts`

- [ ] **Step 1: Delete files**

```bash
git rm apps/web/services/openrouter/laboratory.ts
git rm -r apps/web/services/laboratory
git rm -r apps/web/components/workspace/laboratory
git rm apps/web/tests/services/openrouter/laboratory.test.ts
git rm apps/web/tests/utils/laboratoryFileFilter.test.ts
```

- [ ] **Step 2: Delete laboratory exports from `types.ts`**

Remove these declarations entirely (they are no longer referenced):

```
LaboratoryAttachmentKind
LaboratoryStateStatus
LaboratoryAttachment
LaboratoryExerciseEvaluation
LaboratoryExercise
LaboratoryState
```

- [ ] **Step 3: Drop laboratory from `index.ts` of `services/openrouter`**

If `apps/web/services/openrouter/index.ts` re-exports from `./laboratory.ts`, remove that line.

```bash
grep -n "laboratory" apps/web/services/openrouter/index.ts || true
```
Edit if found.

- [ ] **Step 4: Type-check + tests**

```bash
bun run lint:types
bun run test
```
Expected: PASS.

If anything still references a laboratory symbol, the type checker will say so. Trace and remove. Common straggler spots:
- `apps/web/services/projects/projectSnapshot.ts` (saved-meta computation)
- `apps/web/services/projects/indexedDbProjectRepository.ts`

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(laboratory): hard-delete legacy laboratory subsystem"
```

---

## Task 13: Update `SavedProjectMeta` computation

`projectSnapshot.ts` (or wherever `SavedProjectMeta` is computed from a `ProjectSnapshot`) must populate `exerciseCount` and `completedExercises`.

**Files:**
- Modify: `apps/web/services/projects/projectSnapshot.ts`
- Test:   `apps/web/tests/services/projects/projectSnapshot.test.ts` (create if missing)

- [ ] **Step 1: Locate the meta computation**

```bash
grep -rn "lessonCount" apps/web/services/projects | head
```

- [ ] **Step 2: Write a test**

```ts
// apps/web/tests/services/projects/projectSnapshot.test.ts (or extend existing)
import { describe, expect, it } from 'vitest';
import { computeSavedProjectMeta } from '../../../services/projects/projectSnapshot.ts';
import { AppState, type ProjectSnapshot } from '../../../types.ts';

describe('computeSavedProjectMeta', () => {
  it('counts lessons and exercises separately', () => {
    const snapshot: ProjectSnapshot = {
      id: 'p' as ProjectSnapshot['id'],
      version: '1',
      sourceKind: 'pdf',
      state: AppState.READING,
      source: null,
      isLearnMode: false,
      userProfile: null,
      syllabus: [],
      activeSectionId: null,
      createdAt: '', updatedAt: '', lastOpenedAt: '',
      learningPlan: {
        title: '', summary: '', applicationExercisePlanningStatus: 'completed',
        modules: [{
          id: 'm', title: 'M', children: [
            { kind: 'lesson', id: 'L1', title: '', description: '', isCompleted: true, type: 'core' },
            { kind: 'lesson', id: 'L2', title: '', description: '', isCompleted: false, type: 'core' },
            { kind: 'exercise', id: 'E1', title: '', description: '', assessedObjective: '',
              attachments: [], currentFeedback: null, isCompleted: true, feedbackStale: false,
              updatedAt: '' },
          ],
        }],
      },
    };
    const meta = computeSavedProjectMeta(snapshot, { coverLabel: 'C' });
    expect(meta.lessonCount).toBe(2);
    expect(meta.completedCount).toBe(1);
    expect(meta.exerciseCount).toBe(1);
    expect(meta.completedExercises).toBe(1);
  });
});
```

(Adjust the import path / function signature to match what `projectSnapshot.ts` actually exports.)

- [ ] **Step 3: Update the function**

In `projectSnapshot.ts`:

```ts
import { flattenLessons, flattenPathNodes } from '../../utils/learning/pathNodes.ts';

// inside the meta builder:
const lessons = flattenLessons(snapshot.learningPlan);
const exercises = flattenPathNodes(snapshot.learningPlan).filter(n => n.kind === 'exercise');
return {
  // ... existing fields
  lessonCount: lessons.length,
  completedCount: lessons.filter(l => l.isCompleted).length,
  exerciseCount: exercises.length,
  completedExercises: exercises.filter(e => e.isCompleted).length,
  // ...
};
```

- [ ] **Step 4: Run test**

```bash
bun --bun vitest run --config apps/web/vitest.config.ts apps/web/tests/services/projects/projectSnapshot.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/services/projects/projectSnapshot.ts apps/web/tests/services/projects/projectSnapshot.test.ts
git commit -m "refactor(projects): include exercise counts in saved project meta"
```

---

## Task 14: Final type + test gate

- [ ] **Step 1: Run type checks**

```bash
bun run lint:types
```
Expected: PASS. If failures remain, fix them before continuing. Most common stragglers:
- A test fixture that still uses `learningPlan.sections` directly. Rewrite to use modules.
- A util that imports `LearningSection` from a path that no longer exports it. Replace with `LessonNode`.
- A snapshot fixture that includes `laboratory: ...`. Remove.

- [ ] **Step 2: Run quality**

```bash
bun run quality
```
Expected: PASS.

- [ ] **Step 3: Run tests**

```bash
bun run test
```
Expected: PASS. All test files green; Phase 1 leaves no skipped/xfail tests.

- [ ] **Step 4: Run gate**

```bash
bun run gate
```
Expected: PASS (lint + biome + fallow + tests).

- [ ] **Step 5: Commit any incidental fixes**

```bash
git add -A
git status   # confirm tree is clean or only minor lint fixes remain
git commit -m "chore(phase-1): green type-check, quality, test gate"
```
(Skip if nothing to commit.)

---

## Task 15: Update graphify

- [ ] **Step 1: Refresh graph**

```bash
graphify update .
```
Expected: graph regenerates, `graphify-out/GRAPH_REPORT.md` updated.

- [ ] **Step 2: Commit (only if files changed)**

```bash
git status -- graphify-out
git add graphify-out
git commit -m "chore(graphify): refresh graph after phase 1"
```
(Skip if no changes.)

---

## Phase 1 done

After all tasks: the app compiles, all tests are green, the schema has been swapped to modules, the laboratory is gone, legacy snapshots hydrate cleanly, and `SavedProjectMeta` carries exercise fields. No exercises are generated yet — Phase 2 (placement pass) will start emitting `ApplicationExerciseNode`s into the path.

When you're ready to proceed, ask the orchestrator to write the Phase 2 plan referencing this spec.

---

## Self-review notes (for the planner, not the executor)

- Spec coverage: Phase 1 covers spec §"Data model" + §"Migration" + §"Cleanup of legacy laboratory" + §"`SavedProjectMeta`". It does NOT cover §"AI pipelines", §"Submission + feedback", §"UI for exercises beyond a stub" — those are explicitly deferred to Phases 2–5.
- Type consistency: `LessonNode` is defined in Task 2 and used unmodified in Tasks 3–13. `ApplicationExerciseNode`, `LearningModule`, `PathNode`, `ExerciseAttachment`, `ExerciseFeedback`, `ApplicationExercisePlanningStatus`, `ApplicationExercisePlanningError` likewise.
- Helpers introduced exactly once: `groupSectionsIntoModules` (Task 3), `flattenPathNodes` / `flattenLessons` / `findPathNodeById` / `updateLessons` (Tasks 6 + 9). All consumers reuse them; no copy-paste.
- Constants: `EXERCISE_PASS_THRESHOLD` etc. are introduced in Task 1 but not yet *used* in Phase 1 (they're consumed in Phases 4 + 5). That is intentional — defining them up front prevents drift.
