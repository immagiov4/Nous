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
  type SectionAnnotationTextSelector,
} from '../../../types.ts';
import { flattenLessons } from '../../../utils/learning/pathNodes.ts';
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
}): SectionAnnotation & {
  anchor: { kind: 'selection'; selector: SectionAnnotationTextSelector };
} => ({
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

test('legacy annotation merge preserves distinct IDs and current notes win ID conflicts', () => {
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
  expect(patches[0]?.recoveredCount).toBe(4);
  expect(patches[0]?.annotations.map(annotation => annotation.id)).toEqual([
    'same-id',
    'current-anchor',
    'current-lesson-note',
    'legacy-anchor',
    'legacy-duplicate-note',
    'missing-highlight',
    'missing-note',
  ]);
  expect(patches[0]?.annotations.find(annotation => annotation.id === 'same-id')?.note).toBe(
    'Current note'
  );
});

test('recovery writes distinct notes on the same selection before marking completion', async () => {
  const currentNote = selectionAnnotation({
    end: 5,
    exact: 'hello',
    id: 'current',
    note: 'First note',
    start: 0,
  });
  const legacyNote = { ...currentNote, id: 'legacy', note: 'Another note' };
  const currentSnapshot = buildSnapshot([
    buildTestLesson({ content: 'hello', annotations: [currentNote] }),
  ]);
  const legacySnapshot = buildSnapshot([
    buildTestLesson({ content: 'hello', annotations: [legacyNote] }),
  ]);
  const { storage, values } = createMigrationStorage();
  const patchProject = vi.fn(async () => buildTestProjectMeta({ revision: 2 }));

  await expect(
    recoverLegacyAnnotationsFromStore({
      legacyStore: { close: vi.fn(), loadProject: async () => legacySnapshot },
      migrationStorage: storage,
      projectMetas: [buildTestProjectMeta({ revision: 1 })],
      repository: { loadProject: async () => currentSnapshot, patchProject },
      userId: 'user-1',
    })
  ).resolves.toBe(1);

  expect(patchProject.mock.calls[0]).toBeDefined();
  expect(patchProject).toHaveBeenCalledWith(
    'project-1',
    expect.objectContaining({
      section: { sectionId: 'lesson-1', annotations: [currentNote, legacyNote] },
    }),
    { expectedRevision: 1 }
  );
  expect(values.get('nous:legacy-annotation-recovery:v4:user-1')).toBe('complete');
});

test('partial recovery remembers recovered and existing IDs after deletion across retries', async () => {
  const existingNote = lessonAnnotation('existing-note', 'Already present');
  const recoveredNote = lessonAnnotation('recovered-note', 'Recover once');
  const pendingNote = lessonAnnotation('pending-note', 'Recover later');
  let currentSnapshot = buildSnapshot([buildTestLesson({ annotations: [existingNote] })]);
  const legacySnapshot = buildSnapshot([
    buildTestLesson({ annotations: [existingNote, recoveredNote] }),
    buildTestLesson({ id: 'lesson-2', annotations: [pendingNote] }),
  ]);
  const { storage, values } = createMigrationStorage();
  let revision = 1;
  const patchProject = vi.fn(async (_id: string, patch: ProjectPatch) => {
    const lesson = flattenLessons(currentSnapshot.learningPlan?.modules).find(
      candidate => candidate.id === patch.section?.sectionId
    );
    if (lesson && patch.section?.annotations) {
      lesson.annotations = patch.section.annotations as SectionAnnotation[];
    }
    return buildTestProjectMeta({ revision: ++revision });
  });
  const args = {
    legacyStore: { close: vi.fn(), loadProject: async () => legacySnapshot },
    migrationStorage: storage,
    projectMetas: [buildTestProjectMeta({ revision })],
    repository: { loadProject: async () => currentSnapshot, patchProject },
    userId: 'user-1',
  };

  await expect(recoverLegacyAnnotationsFromStore(args)).resolves.toBe(1);
  expect(values.get('nous:legacy-annotation-recovery:v4:user-1')).toBeUndefined();
  currentSnapshot = buildSnapshot([buildTestLesson({ annotations: [] })]);
  args.projectMetas = [buildTestProjectMeta({ revision })];
  await expect(recoverLegacyAnnotationsFromStore(args)).resolves.toBe(0);
  expect(patchProject).toHaveBeenCalledTimes(1);
  expect(values.get('nous:legacy-annotation-recovery:v4:user-1')).toBeUndefined();

  currentSnapshot = buildSnapshot([
    buildTestLesson({ annotations: [] }),
    buildTestLesson({ id: 'lesson-2', annotations: [] }),
  ]);
  await expect(recoverLegacyAnnotationsFromStore(args)).resolves.toBe(1);
  expect(patchProject).toHaveBeenCalledTimes(2);
  expect(
    flattenLessons(currentSnapshot.learningPlan?.modules).map(lesson => lesson.annotations)
  ).toEqual([[], [pendingNote]]);
  expect(values.get('nous:legacy-annotation-recovery:v4:user-1')).toBe('complete');
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
  expect(values.get('nous:legacy-annotation-recovery:v4:user-1')).toBe('complete');

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

test('a later patch failure retains progress without recording the failed note', async () => {
  const firstNote = lessonAnnotation('note-1', 'Recover once');
  const secondNote = lessonAnnotation('note-2', 'Retry this note');
  const legacySnapshot = buildSnapshot([
    buildTestLesson({ annotations: [firstNote] }),
    buildTestLesson({ id: 'lesson-2', annotations: [secondNote] }),
  ]);
  const emptySnapshot = buildSnapshot([
    buildTestLesson({ annotations: [] }),
    buildTestLesson({ id: 'lesson-2', annotations: [] }),
  ]);
  const { storage, values } = createMigrationStorage();
  const patchProject = vi.fn(async (_id: string, patch: ProjectPatch) => {
    if (patch.section?.sectionId === 'lesson-2') throw new Error('backend unavailable');
    return buildTestProjectMeta({ revision: 2 });
  });
  const args = {
    legacyStore: { close: vi.fn(), loadProject: async () => legacySnapshot },
    migrationStorage: storage,
    projectMetas: [buildTestProjectMeta({ revision: 1 })],
    repository: { loadProject: async () => emptySnapshot, patchProject },
    userId: 'user-1',
  };
  await expect(recoverLegacyAnnotationsFromStore(args)).rejects.toThrow('backend unavailable');
  expect(values.get('nous:legacy-annotation-recovery:v4:user-1')).toBeUndefined();

  // The first note was deleted after its successful write, before retrying the failed section.
  patchProject.mockImplementation(async () => buildTestProjectMeta({ revision: 3 }));
  patchProject.mockClear();
  args.projectMetas = [buildTestProjectMeta({ revision: 2 })];
  await expect(recoverLegacyAnnotationsFromStore(args)).resolves.toBe(1);
  expect(patchProject).toHaveBeenCalledTimes(1);
  expect(patchProject).toHaveBeenCalledWith(
    'project-1',
    expect.objectContaining({
      section: { sectionId: 'lesson-2', annotations: [secondNote] },
    }),
    { expectedRevision: 2 }
  );
  expect(values.get('nous:legacy-annotation-recovery:v4:user-1')).toBe('complete');
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

test('retries keep checking unresolved current notes after all legacy IDs are acknowledged', async () => {
  const unresolved = legacySelectionAnnotation('unresolved-current', 'Keep trying');
  const restored = lessonAnnotation('legacy-note', 'Recovered');
  let currentSnapshot = buildSnapshot([buildTestLesson({ annotations: [unresolved] })]);
  const legacySnapshot = buildSnapshot([buildTestLesson({ annotations: [restored] })]);
  const { storage, values } = createMigrationStorage();
  const patchProject = vi.fn(async (_id: string, patch: ProjectPatch) => {
    currentSnapshot = buildSnapshot([
      buildTestLesson({ annotations: patch.section?.annotations as SectionAnnotation[] }),
    ]);
    return buildTestProjectMeta({ revision: 2 });
  });
  const args = {
    legacyStore: { close: vi.fn(), loadProject: async () => legacySnapshot },
    migrationStorage: storage,
    projectMetas: [buildTestProjectMeta({ revision: 1 })],
    repository: { loadProject: async () => currentSnapshot, patchProject },
    userId: 'user-1',
  };
  await expect(recoverLegacyAnnotationsFromStore(args)).resolves.toBe(1);
  args.projectMetas = [buildTestProjectMeta({ revision: 2 })];
  await expect(recoverLegacyAnnotationsFromStore(args)).resolves.toBe(0);
  expect(values.get('nous:legacy-annotation-recovery:v3:user-1')).toBeUndefined();
  expect(values.get('nous:legacy-annotation-recovery:v4:user-1')).toBeUndefined();
  expect(patchProject).toHaveBeenCalledTimes(1);
  currentSnapshot = buildSnapshot([buildTestLesson({ annotations: [restored] })]);
  await expect(recoverLegacyAnnotationsFromStore(args)).resolves.toBe(0);
  expect(values.get('nous:legacy-annotation-recovery:v4:user-1')).toBe('complete');
});

test.each([
  'selector',
  'markup',
])('completed v3 upgrades only old selection conflicts (%s)', async format => {
  const currentNote = selectionAnnotation({
    end: 5,
    exact: 'hello',
    id: 'current',
    note: 'Current note',
    start: 0,
  });
  const skippedNote = { ...currentNote, id: 'skipped', note: 'Previously skipped note' };
  if (format === 'markup') currentNote.anchor.selector.suffix = 'world';
  const otherSelection = selectionAnnotation({
    end: 11,
    exact: 'world',
    id: 'deleted-selection',
    note: 'Leave deleted',
    start: 6,
  });
  const otherContext = {
    ...skippedNote,
    id: 'different-context',
    anchor: {
      ...currentNote.anchor,
      selector: { ...currentNote.anchor.selector, suffix: ' world' },
    },
  };
  const currentSnapshot = buildSnapshot([
    buildTestLesson({ content: 'hello world', annotations: [currentNote] }),
  ]);
  const legacySnapshot = buildSnapshot([
    buildTestLesson({
      content:
        format === 'markup'
          ? '<mark data-nous-annotation-id="skipped">hello</mark> world'
          : 'hello world',
      annotations: [
        format === 'markup' ? legacySelectionAnnotation('skipped', skippedNote.note) : skippedNote,
        otherSelection,
        otherContext,
        lessonAnnotation('deleted-note', 'Leave deleted'),
      ],
    }),
    buildTestLesson({
      id: 'removed-lesson',
      annotations: [lessonAnnotation('orphan', 'Leave deleted')],
    }),
  ]);
  const { storage, values } = createMigrationStorage();
  values.set('nous:legacy-annotation-recovery:v3:user-1', 'complete');
  const patchProject = vi.fn(async () => buildTestProjectMeta({ revision: 2 }));
  const args = {
    legacyStore: { close: vi.fn(), loadProject: async () => legacySnapshot },
    migrationStorage: storage,
    projectMetas: [buildTestProjectMeta({ revision: 1 })],
    repository: { loadProject: async () => currentSnapshot, patchProject },
    userId: 'user-1',
  };
  await expect(recoverLegacyAnnotationsFromStore(args)).resolves.toBe(1);
  expect(patchProject).toHaveBeenCalledWith(
    'project-1',
    expect.objectContaining({
      section: {
        sectionId: 'lesson-1',
        annotations: [
          currentNote,
          expect.objectContaining({ id: 'skipped', note: skippedNote.note }),
        ],
      },
    }),
    { expectedRevision: 1 }
  );
  expect(values.get('nous:legacy-annotation-recovery:v4:user-1')).toBe('complete');
  await expect(recoverLegacyAnnotationsFromStore(args)).resolves.toBe(0);
  expect(patchProject).toHaveBeenCalledTimes(1);
});

test.each([
  false,
  true,
])('a current ID acknowledges an obsolete legacy anchor (partial: %s)', async partial => {
  const legacyNote = selectionAnnotation({
    end: 5,
    exact: 'hello',
    id: 'shared-id',
    note: 'Old note',
    start: 0,
  });
  const currentNote = selectionAnnotation({
    end: 7,
    exact: 'updated',
    id: 'shared-id',
    note: 'Current note',
    start: 0,
  });
  const legacySnapshot = buildSnapshot([
    buildTestLesson({ content: 'hello', annotations: [legacyNote] }),
    ...(partial
      ? [
          buildTestLesson({
            id: 'missing-lesson',
            annotations: [lessonAnnotation('pending', 'Retry')],
          }),
        ]
      : []),
  ]);
  let currentSnapshot = buildSnapshot([
    buildTestLesson({ content: 'updated', annotations: [currentNote] }),
  ]);
  const { storage, values } = createMigrationStorage();
  const patchProject = vi.fn(async () => buildTestProjectMeta({ revision: 2 }));
  const args = {
    legacyStore: { close: vi.fn(), loadProject: async () => legacySnapshot },
    migrationStorage: storage,
    projectMetas: [buildTestProjectMeta()],
    repository: { loadProject: async () => currentSnapshot, patchProject },
    userId: 'user-1',
  };
  await expect(recoverLegacyAnnotationsFromStore(args)).resolves.toBe(0);
  currentSnapshot = buildSnapshot([buildTestLesson({ content: 'hello', annotations: [] })]);
  await expect(recoverLegacyAnnotationsFromStore(args)).resolves.toBe(0);
  expect(patchProject).not.toHaveBeenCalled();
  expect(values.get('nous:legacy-annotation-recovery:v4:user-1')).toBe(
    partial ? undefined : 'complete'
  );
});

test('v3 upgrade remembers repaired IDs while an unresolved current note prevents completion', async () => {
  const currentNote = selectionAnnotation({
    end: 5,
    exact: 'hello',
    id: 'current',
    note: 'Current',
    start: 0,
  });
  const skippedNote = { ...currentNote, id: 'skipped', note: 'Repair once' };
  const unresolved = legacySelectionAnnotation('unresolved-current', 'Resolve later');
  const legacySnapshot = buildSnapshot([
    buildTestLesson({ content: 'hello', annotations: [skippedNote] }),
  ]);
  let currentSnapshot = buildSnapshot([
    buildTestLesson({ content: 'hello', annotations: [currentNote, unresolved] }),
  ]);
  const { storage, values } = createMigrationStorage();
  values.set('nous:legacy-annotation-recovery:v3:user-1', 'complete');
  const patchProject = vi.fn(async () => buildTestProjectMeta({ revision: 2 }));
  const args = {
    legacyStore: { close: vi.fn(), loadProject: async () => legacySnapshot },
    migrationStorage: storage,
    projectMetas: [buildTestProjectMeta({ revision: 1 })],
    repository: { loadProject: async () => currentSnapshot, patchProject },
    userId: 'user-1',
  };
  await expect(recoverLegacyAnnotationsFromStore(args)).resolves.toBe(1);
  expect(values.get('nous:legacy-annotation-recovery:v4:user-1')).toBeUndefined();
  // The repaired note was deleted; its matching current note remains.
  currentSnapshot = buildSnapshot([
    buildTestLesson({ content: 'hello', annotations: [currentNote, unresolved] }),
  ]);
  args.projectMetas = [buildTestProjectMeta({ revision: 2 })];
  await expect(recoverLegacyAnnotationsFromStore(args)).resolves.toBe(0);
  expect(values.get('nous:legacy-annotation-recovery:v4:user-1')).toBeUndefined();
  expect(patchProject).toHaveBeenCalledTimes(1);
  currentSnapshot = buildSnapshot([
    buildTestLesson({ content: 'hello', annotations: [currentNote] }),
  ]);
  await expect(recoverLegacyAnnotationsFromStore(args)).resolves.toBe(0);
  expect(values.get('nous:legacy-annotation-recovery:v4:user-1')).toBe('complete');
});

test('v3 upgrade acknowledges surviving legacy IDs before a later deletion', async () => {
  const survivor = selectionAnnotation({
    end: 5,
    exact: 'hello',
    id: 'survivor',
    note: 'Original',
    start: 0,
  });
  const skipped = { ...survivor, id: 'skipped', note: 'Repair' };
  const unresolved = legacySelectionAnnotation('unresolved', 'Retry');
  const legacySnapshot = buildSnapshot([
    buildTestLesson({ content: 'hello', annotations: [survivor, skipped] }),
  ]);
  let currentSnapshot = buildSnapshot([
    buildTestLesson({ content: 'hello', annotations: [survivor, unresolved] }),
  ]);
  const { storage, values } = createMigrationStorage();
  values.set('nous:legacy-annotation-recovery:v3:user-1', 'complete');
  const patchProject = vi.fn(async () => buildTestProjectMeta({ revision: 2 }));
  const args = {
    legacyStore: { close: vi.fn(), loadProject: async () => legacySnapshot },
    migrationStorage: storage,
    projectMetas: [buildTestProjectMeta({ revision: 1 })],
    repository: { loadProject: async () => currentSnapshot, patchProject },
    userId: 'user-1',
  };
  await expect(recoverLegacyAnnotationsFromStore(args)).resolves.toBe(1);
  expect(values.get('nous:legacy-annotation-recovery:v4:user-1')).toBeUndefined();
  currentSnapshot = buildSnapshot([
    buildTestLesson({ content: 'hello', annotations: [skipped, unresolved] }),
  ]);
  args.projectMetas = [buildTestProjectMeta({ revision: 2 })];
  await expect(recoverLegacyAnnotationsFromStore(args)).resolves.toBe(0);
  expect(patchProject).toHaveBeenCalledTimes(1);
  expect(values.get('nous:legacy-annotation-recovery:v4:user-1')).toBeUndefined();
  currentSnapshot = buildSnapshot([buildTestLesson({ content: 'hello', annotations: [skipped] })]);
  await expect(recoverLegacyAnnotationsFromStore(args)).resolves.toBe(0);
  expect(values.get('nous:legacy-annotation-recovery:v4:user-1')).toBe('complete');
});

test.each([
  false,
  true,
])('v3 upgrade follows a surviving ID only to an unambiguous current anchor (divergent: %s)', async divergent => {
  const original = selectionAnnotation({
    end: 5,
    exact: 'hello',
    id: 'survivor',
    note: 'Old note',
    start: 0,
  });
  const skipped = { ...original, id: 'skipped', note: 'Distinct note' };
  const current = selectionAnnotation({
    end: 7,
    exact: 'updated',
    id: 'survivor',
    note: 'Edited note',
    start: 0,
  });
  const unrelated = lessonAnnotation('deleted-unrelated', 'Leave absent');
  const anotherSurvivor = selectionAnnotation({
    end: 13,
    exact: 'other',
    id: 'another-survivor',
    note: 'Another survivor',
    start: 8,
  });
  const legacySnapshot = buildSnapshot([
    buildTestLesson({
      content: 'hello',
      annotations: [
        original,
        skipped,
        unrelated,
        ...(divergent ? [{ ...original, id: anotherSurvivor.id }] : []),
      ],
    }),
  ]);
  const currentSnapshot = buildSnapshot([
    buildTestLesson({
      content: divergent ? 'updated other' : 'updated',
      annotations: [current, ...(divergent ? [anotherSurvivor] : [])],
    }),
  ]);
  const { storage, values } = createMigrationStorage();
  values.set('nous:legacy-annotation-recovery:v3:user-1', 'complete');
  const patchProject = vi.fn(async () => buildTestProjectMeta({ revision: 2 }));
  const args = {
    legacyStore: { close: vi.fn(), loadProject: async () => legacySnapshot },
    migrationStorage: storage,
    projectMetas: [buildTestProjectMeta({ revision: 1 })],
    repository: { loadProject: async () => currentSnapshot, patchProject },
    userId: 'user-1',
  };
  await expect(recoverLegacyAnnotationsFromStore(args)).resolves.toBe(divergent ? 0 : 1);
  if (!divergent)
    expect(patchProject).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({
        section: {
          sectionId: 'lesson-1',
          annotations: [current, { ...skipped, anchor: current.anchor }],
        },
      }),
      { expectedRevision: 1 }
    );
  expect(values.get('nous:legacy-annotation-recovery:v4:user-1')).toBe('complete');
  await expect(recoverLegacyAnnotationsFromStore(args)).resolves.toBe(0);
  expect(patchProject).toHaveBeenCalledTimes(divergent ? 0 : 1);
});
