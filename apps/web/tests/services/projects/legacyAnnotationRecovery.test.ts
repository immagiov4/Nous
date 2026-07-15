import { expect, test, vi } from 'vitest';
import {
  buildLegacyAnnotationRecoveryPatches,
  buildLegacyAnnotationRecoveryPlan,
  type LegacySnapshotStore,
  recoverLegacyAnnotationsFromStore,
} from '../../../services/projects/legacyAnnotationRecovery.ts';
import {
  AppState,
  type ProjectPatch,
  type ProjectSnapshot,
  type ProjectWriteOptions,
  type SectionAnnotation,
} from '../../../types.ts';
import {
  buildTestLearningPlan,
  buildTestLesson,
  buildTestProjectMeta,
} from '../../helpers/learningPlan.ts';

const CREATED_AT = '2026-05-01T10:00:00.000Z';

const selectionAnnotation = ({
  end,
  exact,
  id,
  note,
  start,
}: {
  end: number;
  exact: string;
  id: string;
  note: string;
  start: number;
}): SectionAnnotation => ({
  anchor: {
    kind: 'selection',
    selector: { end, exact, prefix: '', start, suffix: '' },
  },
  createdAt: CREATED_AT,
  id,
  note,
  updatedAt: CREATED_AT,
});

const lessonAnnotation = (id: string, note: string): SectionAnnotation => ({
  anchor: { kind: 'lesson' },
  createdAt: CREATED_AT,
  id,
  note,
  updatedAt: CREATED_AT,
});

const legacySelectionAnnotation = (id: string, note = ''): SectionAnnotation =>
  ({
    anchor: { kind: 'selection' },
    createdAt: CREATED_AT,
    id,
    note,
    updatedAt: CREATED_AT,
  }) as unknown as SectionAnnotation;

const buildSnapshot = (sections: Parameters<typeof buildTestLearningPlan>[0]): ProjectSnapshot => ({
  id: 'project-1',
  version: '4.1',
  sourceKind: 'document',
  state: AppState.READING,
  source: null,
  learningPlan: buildTestLearningPlan(sections),
  isLearnMode: false,
  userProfile: null,
  syllabus: [],
  activeSectionId: 'lesson-1',
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  lastOpenedAt: CREATED_AT,
});

const createMigrationStorage = () => {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  };
};

test('legacy annotation merge is additive and current annotations win ID and anchor conflicts', () => {
  const currentSnapshot = buildSnapshot([
    buildTestLesson({
      content: 'hello, world',
      annotations: [
        lessonAnnotation('same-id', 'Current note'),
        selectionAnnotation({ end: 5, exact: 'hello', id: 'current-anchor', note: '', start: 0 }),
        lessonAnnotation('current-lesson-note', 'Keep me'),
      ],
    }),
  ]);
  const legacySnapshot = buildSnapshot([
    buildTestLesson({
      content: 'hello, world',
      annotations: [
        lessonAnnotation('same-id', 'Outdated note'),
        selectionAnnotation({ end: 5, exact: 'hello', id: 'legacy-anchor', note: '', start: 0 }),
        lessonAnnotation('legacy-duplicate-note', 'Keep me'),
        selectionAnnotation({
          end: 12,
          exact: 'world',
          id: 'missing-highlight',
          note: '',
          start: 7,
        }),
        lessonAnnotation('missing-note', 'Restore me'),
      ],
    }),
  ]);

  const patches = buildLegacyAnnotationRecoveryPatches(currentSnapshot, legacySnapshot);

  expect(patches).toHaveLength(1);
  expect(patches[0]?.recoveredCount).toBe(2);
  expect(patches[0]?.annotations.map(annotation => annotation.id)).toEqual([
    'same-id',
    'current-anchor',
    'current-lesson-note',
    'missing-highlight',
    'missing-note',
  ]);
  expect(patches[0]?.annotations.find(annotation => annotation.id === 'same-id')?.note).toBe(
    'Current note'
  );
});

test('legacy recovery patches only matching sections, advances revisions, and completes once', async () => {
  const currentSnapshot = buildSnapshot([
    buildTestLesson({ id: 'lesson-1', annotations: [] }),
    buildTestLesson({ id: 'lesson-2', content: 'test', annotations: [] }),
  ]);
  const legacySnapshot = buildSnapshot([
    buildTestLesson({
      id: 'lesson-1',
      annotations: [lessonAnnotation('note-1', 'First restored note')],
    }),
    buildTestLesson({
      id: 'lesson-2',
      content: '<mark data-nous-annotation-id="highlight-2">test</mark>',
      annotations: [legacySelectionAnnotation('highlight-2')],
    }),
  ]);
  const loadLegacyProject = vi.fn(async () => legacySnapshot);
  const legacyStore: LegacySnapshotStore = {
    close: vi.fn(),
    loadProject: loadLegacyProject,
  };
  let revision = 7;
  const patchProject = vi.fn(
    async (_projectId: string, _patch: ProjectPatch, _options?: ProjectWriteOptions) =>
      buildTestProjectMeta({ revision: ++revision })
  );
  const repository = {
    loadProject: vi.fn(async () => currentSnapshot),
    patchProject,
  };
  const { storage, values } = createMigrationStorage();
  values.set('nous:legacy-annotation-recovery:v1:user-1', 'complete');
  values.set('nous:legacy-annotation-recovery:v2:user-1', 'complete');
  const args = {
    legacyStore,
    migrationStorage: storage,
    projectMetas: [buildTestProjectMeta({ revision: 7 })],
    repository,
    userId: 'user-1',
  };

  await expect(recoverLegacyAnnotationsFromStore(args)).resolves.toBe(2);

  expect(patchProject).toHaveBeenCalledTimes(2);
  expect(patchProject.mock.calls[0]?.[0]).toBe('project-1');
  expect(patchProject.mock.calls[0]?.[1]).toMatchObject({
    section: {
      sectionId: 'lesson-1',
      annotations: [lessonAnnotation('note-1', 'First restored note')],
    },
  });
  expect(patchProject.mock.calls[0]?.[2]).toEqual({ expectedRevision: 7 });
  expect(patchProject.mock.calls[1]?.[1]).toMatchObject({
    section: {
      sectionId: 'lesson-2',
      annotations: [
        {
          anchor: { kind: 'selection', selector: { exact: 'test' } },
          id: 'highlight-2',
          note: '',
        },
      ],
    },
  });
  expect(patchProject.mock.calls[1]?.[2]).toEqual({ expectedRevision: 8 });
  expect(values.size).toBe(3);

  await expect(recoverLegacyAnnotationsFromStore(args)).resolves.toBe(0);
  expect(loadLegacyProject).toHaveBeenCalledTimes(1);
  expect(patchProject).toHaveBeenCalledTimes(2);
});

test('legacy recovery is retryable when a server patch fails', async () => {
  const snapshot = buildSnapshot([
    buildTestLesson({ annotations: [lessonAnnotation('note-1', 'Restore me')] }),
  ]);
  const { storage, values } = createMigrationStorage();

  await expect(
    recoverLegacyAnnotationsFromStore({
      legacyStore: { close: vi.fn(), loadProject: async () => snapshot },
      migrationStorage: storage,
      projectMetas: [buildTestProjectMeta({ revision: 3 })],
      repository: {
        loadProject: async () => buildSnapshot([buildTestLesson({ annotations: [] })]),
        patchProject: async () => {
          throw new Error('backend unavailable');
        },
      },
      userId: 'user-1',
    })
  ).rejects.toThrow('backend unavailable');
  expect(values.size).toBe(0);
});

test('legacy markup enriches an existing current annotation without replacing its note', () => {
  const currentSnapshot = buildSnapshot([
    buildTestLesson({
      content: 'A critical passage for the lesson.',
      annotations: [legacySelectionAnnotation('shared-id', 'Current note')],
    }),
  ]);
  const legacySnapshot = buildSnapshot([
    buildTestLesson({
      content:
        'A <mark data-nous-annotation-id="shared-id">critical passage</mark> for the lesson.',
      annotations: [legacySelectionAnnotation('shared-id', 'Old note')],
    }),
  ]);

  const plan = buildLegacyAnnotationRecoveryPlan(currentSnapshot, legacySnapshot);

  expect(plan.unresolvedAnnotationCount).toBe(0);
  expect(plan.patches).toHaveLength(1);
  expect(plan.patches[0]?.normalizedCount).toBe(1);
  expect(plan.patches[0]?.recoveredCount).toBe(0);
  expect(plan.patches[0]?.annotations[0]).toMatchObject({
    anchor: { kind: 'selection', selector: { exact: 'critical passage' } },
    id: 'shared-id',
    note: 'Current note',
  });
});

test('legacy recovery does not complete while a highlight cannot be resolved in current content', async () => {
  const currentSnapshot = buildSnapshot([
    buildTestLesson({
      content: 'The current lesson no longer contains that passage.',
      annotations: [],
    }),
  ]);
  const legacySnapshot = buildSnapshot([
    buildTestLesson({
      content: '<mark data-nous-annotation-id="lost-highlight">Removed passage</mark>',
      annotations: [legacySelectionAnnotation('lost-highlight')],
    }),
  ]);
  const { storage, values } = createMigrationStorage();
  const patchProject = vi.fn();

  await expect(
    recoverLegacyAnnotationsFromStore({
      legacyStore: { close: vi.fn(), loadProject: async () => legacySnapshot },
      migrationStorage: storage,
      projectMetas: [buildTestProjectMeta({ revision: 5 })],
      repository: { loadProject: async () => currentSnapshot, patchProject },
      userId: 'user-1',
    })
  ).resolves.toBe(0);

  expect(patchProject).not.toHaveBeenCalled();
  expect(values.size).toBe(0);
});

test('legacy recovery does not complete when an annotated lesson no longer exists', async () => {
  const currentSnapshot = buildSnapshot([buildTestLesson({ id: 'current-lesson' })]);
  const legacySnapshot = buildSnapshot([
    buildTestLesson({
      id: 'removed-lesson',
      annotations: [lessonAnnotation('orphan-note', 'Keep this recoverable')],
    }),
  ]);
  const { storage, values } = createMigrationStorage();
  const patchProject = vi.fn();

  await expect(
    recoverLegacyAnnotationsFromStore({
      legacyStore: { close: vi.fn(), loadProject: async () => legacySnapshot },
      migrationStorage: storage,
      projectMetas: [buildTestProjectMeta({ revision: 5 })],
      repository: { loadProject: async () => currentSnapshot, patchProject },
      userId: 'user-1',
    })
  ).resolves.toBe(0);

  expect(patchProject).not.toHaveBeenCalled();
  expect(values.size).toBe(0);
});
