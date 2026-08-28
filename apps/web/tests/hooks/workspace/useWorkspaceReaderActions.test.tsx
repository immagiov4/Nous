// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useWorkspaceReaderActions } from '../../../hooks/workspace/useWorkspaceReaderActions.ts';
import {
  LESSON_SOURCE_UNAVAILABLE_MESSAGE,
  LessonSourceUnavailableError,
} from '../../../services/openrouter/lessonGenerationClient.ts';
import { buildTestLearningPlan, buildTestLesson } from '../../helpers/learningPlan.ts';

type HookArgs = Parameters<typeof useWorkspaceReaderActions>[0];

afterEach(() => {
  vi.restoreAllMocks();
});

const buildHookArgs = (overrides: Partial<HookArgs> = {}): HookArgs => ({
  activeSectionId: null,
  advanceActiveSection: vi.fn(async () => 'noop' as const),
  askContextQuestion: vi.fn(async () => ({})),
  closeContextMenu: vi.fn(),
  completeActiveSection: vi.fn(async () => 'noop' as const),
  contextMenu: {} as HookArgs['contextMenu'],
  contextMenuScrollTopRef: { current: null },
  createLessonFromSelection: vi.fn(async () => ({ outcome: 'failed' as const })),
  documentIndex: null,
  isMobileViewport: false,
  learningPlan: null,
  notify: vi.fn(),
  openContextAnswer: vi.fn(),
  openExercise: vi.fn(async () => undefined),
  openSection: vi.fn(async () => undefined),
  patchSectionAnnotations: vi.fn(async () => true),
  projectId: 'project-1',
  regenerateActiveSection: vi.fn(async () => 'loaded' as const),
  scrollContainerRef: { current: null },
  sectionContent: '',
  setIsMobileSidebarOpen: vi.fn(),
  source: null,
  updateSection: vi.fn(),
  ...overrides,
});

test('regeneration reports the missing persisted source rejection instead of failing silently', async () => {
  const notify = vi.fn();
  const { result } = renderHook(() =>
    useWorkspaceReaderActions(
      buildHookArgs({
        notify,
        regenerateActiveSection: vi.fn(async () => {
          throw new LessonSourceUnavailableError();
        }),
      })
    )
  );

  act(() => {
    result.current.handleRegenerateActiveSection();
  });

  await waitFor(() => {
    expect(notify).toHaveBeenCalledWith(LESSON_SOURCE_UNAVAILABLE_MESSAGE);
  });
});

test('saves retained-answer notes to their originating lesson after same-course navigation', async () => {
  const updateSection = vi.fn();
  const patchSectionAnnotations = vi.fn(async () => true);
  const learningPlan = buildTestLearningPlan([
    buildTestLesson({
      content: 'Contenuto originario della lezione.',
      id: 'lesson-origin',
      title: 'Origine',
    }),
    buildTestLesson({
      content: 'Contenuto della lezione aperta.',
      id: 'lesson-active',
      title: 'Aperta',
    }),
  ]);
  const { result } = renderHook(() =>
    useWorkspaceReaderActions(
      buildHookArgs({
        activeSectionId: 'lesson-active',
        learningPlan,
        patchSectionAnnotations,
        sectionContent: 'Contenuto della lezione aperta.',
        updateSection,
      })
    )
  );

  const saveResult = await result.current.handleSaveConversationNote(
    { lessonId: 'lesson-origin' },
    { note: 'Nota dalla conversazione trattenuta', selectedText: 'originario' }
  );

  expect(saveResult?.saved).toBe(true);
  expect(updateSection).toHaveBeenCalledWith('lesson-origin', expect.any(Function));
  expect(patchSectionAnnotations).toHaveBeenCalledWith(
    'lesson-origin',
    expect.any(Array),
    undefined,
    undefined
  );
  expect(updateSection).not.toHaveBeenCalledWith('lesson-active', expect.any(Function));
});

test('restores active-lesson note state and reader scroll when persistence fails', async () => {
  const content = 'Contenuto originario della lezione.';
  const originalAnnotations = [
    {
      anchor: {
        kind: 'selection' as const,
        selector: {
          end: 20,
          exact: 'originario',
          prefix: 'Contenuto ',
          start: 10,
          suffix: ' della lezione.',
        },
      },
      createdAt: '2026-05-01T09:00:00.000Z',
      id: 'annotation-existing',
      note: 'Nota originale',
      updatedAt: '2026-05-01T09:00:00.000Z',
    },
  ];
  const existingVisual = {
    id: 'visual-existing',
    title: 'mappa_esistente',
    kind: 'svg' as const,
    code: '<svg viewBox="0 0 680 120"></svg>',
    createdAt: '2026-05-01T10:00:00.000Z',
  };
  const newVisual = { ...existingVisual, id: 'visual-new', title: 'mappa_nuova' };
  const originLesson = buildTestLesson({
    annotations: originalAnnotations,
    content,
    generatedVisuals: [existingVisual],
    id: 'lesson-origin',
    title: 'Origine',
  });
  const scrollContainer = { scrollTop: 72 } as HTMLElement;
  let currentLesson = originLesson;
  const updateSection: HookArgs['updateSection'] = vi.fn((sectionId, updater) => {
    expect(sectionId).toBe('lesson-origin');
    currentLesson = updater(currentLesson);
    scrollContainer.scrollTop = 0;
  });
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => {
    callback(0);
    return 1;
  });
  const patchSectionAnnotations = vi.fn(async () => false);
  const { result } = renderHook(() =>
    useWorkspaceReaderActions(
      buildHookArgs({
        activeSectionId: 'lesson-origin',
        learningPlan: buildTestLearningPlan([originLesson]),
        patchSectionAnnotations,
        scrollContainerRef: { current: scrollContainer },
        sectionContent: content,
        updateSection,
      })
    )
  );
  const input = {
    generatedVisuals: [newVisual],
    note: 'Nota aggiornata',
    selectedText: 'originario',
    selectedTextStart: 10,
  };

  const saveResult = await result.current.handleSaveConversationNote(
    { lessonId: 'lesson-origin', projectId: 'project-1' },
    input
  );
  expect(saveResult.saved).toBe(false);
  expect(currentLesson.annotations).toBe(originalAnnotations);
  expect(currentLesson.generatedVisuals).toBe(originLesson.generatedVisuals);
  expect(scrollContainer.scrollTop).toBe(72);

  const updateResult = await result.current.handleUpdateConversationNote(
    { lessonId: 'lesson-origin', projectId: 'project-1' },
    input
  );
  expect(updateResult.saved).toBe(false);
  expect(currentLesson.annotations).toBe(originalAnnotations);
  expect(currentLesson.generatedVisuals).toBe(originLesson.generatedVisuals);
  expect(scrollContainer.scrollTop).toBe(72);
  expect(updateSection).toHaveBeenCalledTimes(4);
});

test('saves and replaces retained-answer artifacts on their originating lesson', async () => {
  const existingVisual = {
    id: 'visual-existing',
    title: 'mappa_esistente',
    kind: 'svg' as const,
    code: '<svg viewBox="0 0 680 120"></svg>',
    createdAt: '2026-05-01T10:00:00.000Z',
  };
  const savedVisual = {
    ...existingVisual,
    id: 'visual-new',
    title: 'mappa_nuova',
  };
  const replacementVisual = {
    createdAt: '2026-05-02T10:00:00.000Z',
    id: 'visual-replacement',
    render: { code: '<svg data-replacement="true"></svg>', kind: 'svg' as const },
    slotId: 'artifact-draft',
    title: 'mappa_sostitutiva',
  };
  const updateSection = vi.fn();
  const patchSectionAnnotations = vi.fn(async () => true);
  const learningPlan = buildTestLearningPlan([
    buildTestLesson({
      annotations: [
        {
          anchor: { kind: 'lesson' },
          createdAt: '2026-05-01T09:00:00.000Z',
          id: 'annotation-existing',
          note: 'Nota da preservare',
          updatedAt: '2026-05-01T09:00:00.000Z',
        },
      ],
      contentBlocks: [
        { markdown: 'Contenuto della lezione.', type: 'markdown' },
        {
          slotId: 'lesson-slot-existing',
          type: 'generated-visual',
          visualId: existingVisual.id,
        },
      ],
      generatedVisuals: [existingVisual],
      id: 'lesson-origin',
      title: 'Origine',
    }),
    buildTestLesson({ id: 'lesson-active', title: 'Aperta' }),
  ]);
  const { result } = renderHook(() =>
    useWorkspaceReaderActions(
      buildHookArgs({
        activeSectionId: 'lesson-active',
        learningPlan,
        patchSectionAnnotations,
        updateSection,
      })
    )
  );
  const target = { lessonId: 'lesson-origin', projectId: 'project-1' };

  await result.current.handleSaveArtifactToLesson(target, savedVisual, {
    artifactId: 'artifact-new',
    kind: 'generated-visual',
    title: 'Mappa nuova',
  });
  await result.current.handleReplaceArtifactInLesson(
    target,
    'project-1:lesson-origin:generated-visual:visual-existing',
    replacementVisual
  );

  expect(updateSection).toHaveBeenCalledTimes(2);
  expect(updateSection).toHaveBeenNthCalledWith(1, 'lesson-origin', expect.any(Function));
  expect(updateSection).toHaveBeenNthCalledWith(2, 'lesson-origin', expect.any(Function));
  expect(patchSectionAnnotations).toHaveBeenCalledTimes(2);
  expect(patchSectionAnnotations).toHaveBeenNthCalledWith(
    1,
    'lesson-origin',
    expect.any(Array),
    undefined,
    expect.any(Array)
  );
  expect(patchSectionAnnotations).toHaveBeenNthCalledWith(
    2,
    'lesson-origin',
    undefined,
    undefined,
    [
      expect.objectContaining({
        id: existingVisual.id,
        render: replacementVisual.render,
        slotId: 'lesson-slot-existing',
      }),
    ]
  );
});

test('rolls back optimistic artifact state when persistence fails', async () => {
  const existingVisual = {
    id: 'visual-existing',
    title: 'mappa_esistente',
    kind: 'svg' as const,
    code: '<svg viewBox="0 0 680 120"></svg>',
    createdAt: '2026-05-01T10:00:00.000Z',
  };
  const originalAnnotations = [
    {
      anchor: { kind: 'lesson' as const },
      createdAt: '2026-05-01T09:00:00.000Z',
      id: 'annotation-existing',
      note: 'Nota da preservare',
      updatedAt: '2026-05-01T09:00:00.000Z',
    },
  ];
  const originLesson = buildTestLesson({
    annotations: originalAnnotations,
    generatedVisuals: [existingVisual],
    id: 'lesson-origin',
    title: 'Origine',
  });
  let currentLesson = originLesson;
  const updateSection: HookArgs['updateSection'] = vi.fn((sectionId, updater) => {
    expect(sectionId).toBe('lesson-origin');
    currentLesson = updater(currentLesson);
  });
  const patchSectionAnnotations = vi.fn(async () => false);
  const { result } = renderHook(() =>
    useWorkspaceReaderActions(
      buildHookArgs({
        activeSectionId: 'lesson-origin',
        learningPlan: buildTestLearningPlan([originLesson]),
        patchSectionAnnotations,
        updateSection,
      })
    )
  );
  const target = { lessonId: 'lesson-origin', projectId: 'project-1' };

  const saveResult = await result.current.handleSaveArtifactToLesson(
    target,
    { ...existingVisual, id: 'visual-new', title: 'mappa_nuova' },
    { artifactId: 'artifact-new', kind: 'generated-visual', title: 'Mappa nuova' }
  );

  expect(saveResult.succeeded).toBe(false);
  expect(currentLesson.annotations).toBe(originalAnnotations);
  expect(currentLesson.generatedVisuals).toBe(originLesson.generatedVisuals);

  const replaceResult = await result.current.handleReplaceArtifactInLesson(
    target,
    'project-1:lesson-origin:generated-visual:visual-existing',
    { ...existingVisual, id: 'visual-replacement', title: 'mappa_sostitutiva' }
  );

  expect(replaceResult.succeeded).toBe(false);
  expect(currentLesson.annotations).toBe(originalAnnotations);
  expect(currentLesson.generatedVisuals).toBe(originLesson.generatedVisuals);
  expect(updateSection).toHaveBeenCalledTimes(4);
});

test('rejects retained-answer mutations after cross-course navigation', async () => {
  const updateSection = vi.fn();
  const patchSectionAnnotations = vi.fn(async () => true);
  const { result } = renderHook(() =>
    useWorkspaceReaderActions(
      buildHookArgs({
        activeSectionId: 'lesson-active',
        learningPlan: buildTestLearningPlan([
          buildTestLesson({ id: 'lesson-active', title: 'Aperta' }),
        ]),
        patchSectionAnnotations,
        updateSection,
      })
    )
  );

  const saveResult = await result.current.handleSaveConversationNote(
    { lessonId: 'lesson-origin', projectId: 'project-other' },
    { note: 'Nota', selectedText: 'testo' }
  );

  expect(saveResult?.saved).toBe(false);
  expect(saveResult?.error).toBe('Il corso originale non è più attivo.');
  const artifactSaveResult = await result.current.handleSaveArtifactToLesson(
    { lessonId: 'lesson-origin', projectId: 'project-other' },
    {
      id: 'visual-new',
      title: 'visuale_nuovo',
      kind: 'svg',
      code: '<svg viewBox="0 0 680 120"></svg>',
      createdAt: '2026-05-01T10:00:00.000Z',
    },
    { artifactId: 'artifact-new', kind: 'generated-visual', title: 'Visuale nuovo' }
  );
  const artifactReplaceResult = await result.current.handleReplaceArtifactInLesson(
    { lessonId: 'lesson-origin', projectId: 'project-other' },
    'project-1:lesson-origin:generated-visual:visual-existing',
    {
      id: 'visual-replacement',
      title: 'visuale_sostitutivo',
      kind: 'svg',
      code: '<svg viewBox="0 0 680 120"></svg>',
      createdAt: '2026-05-01T10:00:00.000Z',
    }
  );

  expect(artifactSaveResult).toEqual({
    error: 'Il corso originale non è più attivo.',
    succeeded: false,
  });
  expect(artifactReplaceResult).toEqual({
    error: 'Il corso originale non è più attivo.',
    succeeded: false,
  });
  expect(updateSection).not.toHaveBeenCalled();
  expect(patchSectionAnnotations).not.toHaveBeenCalled();
});
