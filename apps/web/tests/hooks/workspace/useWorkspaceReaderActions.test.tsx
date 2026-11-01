import * as documentTextService from '../../../services/projects/documentText';
import { buildConversationNoteCatalog } from '../../../utils/context/conversationNoteCatalog.ts';
import { createDeferred } from '../../helpers/deferred';
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

test.each([
  true,
  false,
])('playback artifact removal persists and rolls back on failure: %s', async persisted => {
  const visual = {
    id: 'visual-draft-saved',
    kind: 'scene' as const,
    title: 'Memoria',
    code: '',
    createdAt: '2026-10-24',
  };
  const otherVisual = { ...visual, id: 'visual-draft-other' };
  const artifactId = 'project-1:lesson-1:generated-visual:visual-draft-saved';
  const otherRef = { artifactId: 'other', kind: 'generated-visual' as const };
  const annotation = {
    id: 'saved',
    note: '',
    createdAt: '',
    updatedAt: '',
    artifactRefs: [{ artifactId, kind: 'generated-visual' as const }],
  };
  const lesson = buildTestLesson({
    id: 'lesson-1',
    generatedVisuals: [visual, otherVisual],
    annotations: [
      annotation,
      {
        ...annotation,
        id: 'note',
        note: 'Keep this note',
        artifactRefs: [...annotation.artifactRefs, otherRef],
      },
    ],
  });
  let current = lesson;
  const patchSectionAnnotations = vi.fn(async () => persisted);
  const { result } = renderHook(() =>
    useWorkspaceReaderActions(
      buildHookArgs({
        learningPlan: buildTestLearningPlan([lesson]),
        patchSectionAnnotations,
        updateSection: (_id, update) => {
          current = update(current);
        },
      })
    )
  );
  const outcome = await result.current.handleRemovePlaybackVisual(
    { projectId: 'project-1', lessonId: 'lesson-1' },
    visual.id
  );
  expect(patchSectionAnnotations).toHaveBeenCalledWith(
    'lesson-1',
    [{ ...annotation, id: 'note', note: 'Keep this note', artifactRefs: [otherRef] }],
    undefined,
    [otherVisual]
  );
  expect(current.generatedVisuals).toEqual(persisted ? [otherVisual] : lesson.generatedVisuals);
  expect(current.annotations).toEqual(
    persisted
      ? [{ ...annotation, id: 'note', note: 'Keep this note', artifactRefs: [otherRef] }]
      : lesson.annotations
  );
  expect(outcome.succeeded).toBe(persisted);
});

test('saved playback scene has an annotation linking its source passage', async () => {
  const lesson = buildTestLesson({ id: 'lesson-1', content: 'La memoria conserva i dati.' });
  const patchSectionAnnotations = vi.fn(async () => true);
  const { result } = renderHook(() =>
    useWorkspaceReaderActions(
      buildHookArgs({
        learningPlan: buildTestLearningPlan([lesson]),
        patchSectionAnnotations,
      })
    )
  );
  const selector = {
    start: 0,
    end: 27,
    exact: 'La memoria conserva i dati.',
    prefix: '',
    suffix: '',
  };
  await result.current.handleSaveArtifactToLesson(
    { projectId: 'project-1', lessonId: 'lesson-1' },
    { id: 'visual-draft-new', title: 'Memoria', kind: 'scene', code: '', createdAt: '' },
    {
      artifactId: 'project-1:lesson-1:generated-visual:visual-draft-new',
      kind: 'generated-visual',
      title: 'Memoria',
    },
    selector
  );
  expect(patchSectionAnnotations.mock.calls[0]).toEqual([
    'lesson-1',
    [
      expect.objectContaining({
        anchor: { kind: 'selection', selector },
        artifactRefs: [
          {
            artifactId: 'project-1:lesson-1:generated-visual:visual-draft-new',
            kind: 'generated-visual',
            title: 'Memoria',
          },
        ],
      }),
    ],
    undefined,
    [expect.objectContaining({ id: 'visual-draft-new', kind: 'scene' })],
  ]);
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

test.each([
  'failed',
  'blocked-missing-source',
] as const)('regeneration keeps an inline %s outcome out of notifications', async outcome => {
  const notify = vi.fn();
  const regenerateActiveSection = vi.fn(async () => outcome);
  const { result } = renderHook(() =>
    useWorkspaceReaderActions(buildHookArgs({ notify, regenerateActiveSection }))
  );
  await act(async () => {
    result.current.handleRegenerateActiveSection();
  });
  expect(regenerateActiveSection).toHaveBeenCalledOnce();
  expect(notify).not.toHaveBeenCalled();
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
    {
      ...exactNoteInput('Contenuto originario della lezione.'),
      note: 'Nota dalla conversazione trattenuta',
    }
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
          prefix: 'Contenuto',
          start: 10,
          suffix: 'della lezione.',
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
    annotationId: 'annotation-existing',
    exactTarget: {
      content,
      selector: originalAnnotations[0].anchor.selector,
      segments: [{ start: 10, end: 20 }],
    },
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
    { ...exactNoteInput('testo'), note: 'Nota' }
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

test('keeps a pending context question when autosave adopts an equivalent source', async () => {
  const source: NonNullable<HookArgs['source']> = {
    kind: 'pdf',
    file: { name: 'source.pdf', mimeType: 'application/pdf', data: '' },
    ref: {
      id: 'source',
      name: 'source.pdf',
      mimeType: 'application/pdf',
      hash: 'source-hash',
      byteSize: 1,
      objectPath: 'source/original',
    },
  };
  const documentIndex: NonNullable<HookArgs['documentIndex']> = {
    kind: 'pdf-text-index',
    parsedAt: '2026-10-21',
    textDeferred: true,
    chunks: [],
  };
  const loaded = createDeferred();
  vi.spyOn(documentTextService, 'loadDocumentText').mockReturnValue(
    loaded.promise.then(() => ({ source, documentIndex: null }))
  );
  const openContextAnswer = vi.fn();
  const args = buildHookArgs({
    source,
    documentIndex,
    activeSectionId: 'lesson',
    learningPlan: buildTestLearningPlan([
      buildTestLesson({ id: 'lesson', content: 'Lesson text' }),
    ]),
    contextMenu: { ...buildHookArgs().contextMenu, type: 'lesson' },
    openContextAnswer,
  });
  const { result, rerender } = renderHook((props: HookArgs) => useWorkspaceReaderActions(props), {
    initialProps: args,
  });
  let question: Promise<void>;
  act(() => {
    question = result.current.handleContextQuestion('Explain this');
  });
  rerender({ ...args, source: { ...source, file: { ...source.file } } });
  await act(async () => {
    loaded.resolve();
    await question;
  });
  expect(openContextAnswer).toHaveBeenCalledWith(
    expect.objectContaining({ initialQuestion: 'Explain this', lessonId: 'lesson' })
  );
});

const exactNoteInput = (content: string, index = 0) => {
  const passage = buildConversationNoteCatalog({ content, locale: 'en' }).entries[index];
  return {
    ...passage.anchor,
    note: `Note ${index}`,
    exactTarget: { content, selector: passage.selector, segments: passage.segments },
  };
};

test.each([
  'Formula A/B valida. Another sentence.',
  'Before. Formula A+B valida. Another sentence.',
  'Another sentence.',
  'Formula A+B valida. Formula A+B valida.',
])('contextual create/update reject changed source without relocation: %s', async content => {
  const original = 'Formula A+B valida. Another sentence.';
  const input = { ...exactNoteInput(original), annotationId: 'captured' };
  const lesson = buildTestLesson({
    id: 'lesson-1',
    content,
    annotations: [
      {
        id: 'captured',
        note: 'Original note',
        createdAt: '',
        updatedAt: '',
        anchor: { kind: 'selection', selector: exactNoteInput(content).exactTarget.selector },
      },
    ],
  });
  const args = buildHookArgs({ learningPlan: buildTestLearningPlan([lesson]) });
  const { result } = renderHook(() => useWorkspaceReaderActions(args));
  for (const mutate of [
    result.current.handleSaveConversationNote,
    result.current.handleUpdateConversationNote,
  ]) {
    const outcome = await mutate({ lessonId: 'lesson-1', projectId: 'project-1' }, input);
    expect(outcome).toMatchObject({ saved: false, code: 'stale_context' });
  }
  expect(args.patchSectionAnnotations).not.toHaveBeenCalled();
  expect(args.updateSection).not.toHaveBeenCalled();
});

test('a deleted captured annotation cannot update an overlapping replacement', async () => {
  const content = 'First sentence. Second sentence.';
  const input = { ...exactNoteInput(content), annotationId: 'deleted' };
  const replacement = {
    id: 'replacement',
    note: 'Keep me',
    createdAt: '',
    updatedAt: '',
    anchor: { kind: 'selection' as const, selector: input.exactTarget.selector },
  };
  const args = buildHookArgs({
    learningPlan: buildTestLearningPlan([
      buildTestLesson({ id: 'lesson-1', content, annotations: [replacement] }),
    ]),
  });
  const { result } = renderHook(() => useWorkspaceReaderActions(args));
  expect(
    await result.current.handleUpdateConversationNote(
      { lessonId: 'lesson-1', projectId: 'project-1' },
      input
    )
  ).toMatchObject({ saved: false, code: 'target_annotation_missing' });
  expect(args.patchSectionAnnotations).not.toHaveBeenCalled();
});

test('two contextual notes on different sentences in one paragraph retain distinct serialized selectors', async () => {
  const content = 'First sentence. Second sentence.';
  let lesson = buildTestLesson({ id: 'lesson-1', content });
  const args = buildHookArgs({
    learningPlan: buildTestLearningPlan([lesson]),
    updateSection: (_id, update) => {
      lesson = update(lesson);
    },
  });
  const { result, rerender } = renderHook(() => useWorkspaceReaderActions(args));
  for (const index of [0, 1]) {
    expect(
      (
        await result.current.handleSaveConversationNote(
          { lessonId: 'lesson-1', projectId: 'project-1' },
          exactNoteInput(content, index)
        )
      ).saved
    ).toBe(true);
    args.learningPlan = buildTestLearningPlan([lesson]);
    rerender();
  }
  const reloaded = JSON.parse(JSON.stringify(lesson));
  expect(reloaded.annotations).toHaveLength(2);
  expect(reloaded.annotations.map((a: { note: string }) => a.note)).toEqual(['Note 0', 'Note 1']);
  expect(
    reloaded.annotations.map(
      (a: { anchor: { selector: { exact: string } } }) => a.anchor.selector.exact
    )
  ).toEqual(['First sentence.', 'Second sentence.']);
});

test('updates only the captured annotation at the exact approved passage', async () => {
  const content = 'First sentence. Second sentence.';
  const input = { ...exactNoteInput(content), annotationId: 'captured', note: 'Updated' };
  const captured = {
    id: 'captured',
    note: 'Old',
    createdAt: '',
    updatedAt: '',
    anchor: { kind: 'selection' as const, selector: input.exactTarget.selector },
  };
  const other = {
    ...captured,
    id: 'other',
    note: 'Keep other',
    anchor: {
      kind: 'selection' as const,
      selector: exactNoteInput(content, 1).exactTarget.selector,
    },
  };
  const args = buildHookArgs({
    learningPlan: buildTestLearningPlan([
      buildTestLesson({ id: 'lesson-1', content, annotations: [captured, other] }),
    ]),
  });
  const { result } = renderHook(() => useWorkspaceReaderActions(args));
  expect(
    await result.current.handleUpdateConversationNote(
      { lessonId: 'lesson-1', projectId: 'project-1' },
      input
    )
  ).toMatchObject({ saved: true, annotationId: 'captured', resolvedText: 'First sentence.' });
  expect(args.patchSectionAnnotations).toHaveBeenCalledWith(
    'lesson-1',
    [expect.objectContaining({ id: 'captured', note: 'Updated', anchor: captured.anchor }), other],
    undefined,
    undefined
  );
});

test('context-question capture carries the clicked annotation ID', async () => {
  vi.spyOn(documentTextService, 'loadDocumentText').mockResolvedValue({
    source: null,
    documentIndex: null,
  });
  const content = 'First sentence. Second sentence.';
  const input = exactNoteInput(content);
  const annotation = {
    id: 'clicked',
    note: 'Existing',
    createdAt: '',
    updatedAt: '',
    anchor: { kind: 'selection' as const, selector: input.exactTarget.selector },
  };
  const args = buildHookArgs({
    activeSectionId: 'lesson-1',
    contextMenu: {
      type: 'annotation',
      annotationId: 'clicked',
      selectedText: 'First sentence.',
    } as HookArgs['contextMenu'],
    learningPlan: buildTestLearningPlan([
      buildTestLesson({ id: 'lesson-1', content, annotations: [annotation] }),
    ]),
  });
  const { result } = renderHook(() => useWorkspaceReaderActions(args));
  await result.current.handleContextQuestion('Explain');
  expect(args.openContextAnswer).toHaveBeenCalledWith(
    expect.objectContaining({ attachedAnnotationId: 'clicked', attachedAnnotationNote: 'Existing' })
  );
});

test.each([
  { stored: undefined, active: true, matches: true },
  { stored: '', active: true, matches: true },
  { stored: undefined, active: false, matches: true },
  { stored: '', active: false, matches: true },
  { stored: undefined, active: true, matches: false },
  { stored: '', active: true, matches: false },
  { stored: 'Different persisted sentence.', active: true, matches: true },
])('exact note writes use only the matching active reader source: $stored/$active/$matches', async ({
  stored,
  active,
  matches,
}) => {
  const source = 'First sentence. Second sentence.';
  const input = { ...exactNoteInput(source), annotationId: 'captured' };
  const annotation = {
    id: 'captured',
    note: 'Original note',
    createdAt: '',
    updatedAt: '',
    anchor: { kind: 'selection' as const, selector: input.exactTarget.selector },
  };
  const args = buildHookArgs({
    activeSectionId: active ? 'lesson-1' : 'other',
    sectionContent: matches ? source : 'Changed reader sentence.',
    learningPlan: buildTestLearningPlan([
      buildTestLesson({ id: 'lesson-1', content: stored, annotations: [annotation] }),
    ]),
  });
  const { result } = renderHook(() => useWorkspaceReaderActions(args));
  const accepted = active && matches && !stored;
  for (const mutate of [
    result.current.handleSaveConversationNote,
    result.current.handleUpdateConversationNote,
  ]) {
    const outcome = await mutate({ lessonId: 'lesson-1', projectId: 'project-1' }, input);
    expect(outcome.saved).toBe(accepted);
    if (accepted) expect(outcome.resolvedText).toBe('First sentence.');
    else expect(outcome.code).toBe('stale_context');
  }
  expect(args.patchSectionAnnotations).toHaveBeenCalledTimes(accepted ? 2 : 0);
  if (accepted) {
    for (const [, annotations] of vi.mocked(args.patchSectionAnnotations).mock.calls)
      expect(annotations).toEqual([
        expect.objectContaining({ id: 'captured', anchor: annotation.anchor }),
      ]);
  } else expect(args.updateSection).not.toHaveBeenCalled();
});

test('a different sentence creates a new note while the attached annotation stays unchanged', async () => {
  const content = 'First sentence. Second sentence.';
  const original = {
    id: 'attached',
    note: 'Keep original',
    createdAt: '',
    updatedAt: '',
    anchor: { kind: 'selection' as const, selector: exactNoteInput(content).exactTarget.selector },
  };
  const args = buildHookArgs({
    learningPlan: buildTestLearningPlan([
      buildTestLesson({ id: 'lesson-1', content, annotations: [original] }),
    ]),
  });
  const { result } = renderHook(() => useWorkspaceReaderActions(args));
  const catalog = buildConversationNoteCatalog({
    content,
    locale: 'en',
    annotationId: original.id,
    annotationSelector: original.anchor.selector,
    hasExistingNote: true,
    selection: { selectedText: 'First', selectedTextStart: 0 },
  });
  const passage = catalog.entries.find(entry => entry.id === 'p1');
  expect(passage).toBeDefined();
  if (!passage) throw new Error('Expected second sentence');
  const mutate = passage.hasExistingNote
    ? result.current.handleUpdateConversationNote
    : result.current.handleSaveConversationNote;
  const outcome = await mutate(
    { projectId: 'project-1', lessonId: 'lesson-1' },
    {
      ...passage.anchor,
      note: 'New note',
      annotationId: passage.annotationId,
      exactTarget: {
        content: passage.content,
        selector: passage.selector,
        segments: passage.segments,
      },
    }
  );
  expect(outcome.saved).toBe(true);
  expect(outcome.annotationId).not.toBe(original.id);
  expect(args.patchSectionAnnotations).toHaveBeenCalledWith(
    'lesson-1',
    [
      original,
      expect.objectContaining({
        note: 'New note',
        anchor: { kind: 'selection', selector: passage.selector },
      }),
    ],
    undefined,
    undefined
  );
});

test('a partial selection captures and updates the attached annotation full exact target', async () => {
  vi.spyOn(documentTextService, 'loadDocumentText').mockResolvedValue({
    source: null,
    documentIndex: null,
  });
  const content = 'First sentence. Second sentence.';
  const selector = exactNoteInput(content).exactTarget.selector;
  const original = {
    id: 'attached',
    note: 'Old note',
    createdAt: '',
    updatedAt: '',
    anchor: { kind: 'selection' as const, selector },
  };
  const args = buildHookArgs({
    activeSectionId: 'lesson-1',
    contextMenu: {
      type: 'selection',
      selectedText: 'First',
      selectedTextStart: 0,
    } as HookArgs['contextMenu'],
    learningPlan: buildTestLearningPlan([
      buildTestLesson({ id: 'lesson-1', content, annotations: [original] }),
    ]),
  });
  const { result } = renderHook(() => useWorkspaceReaderActions(args));
  await result.current.handleContextQuestion('Explain this word');
  const captured = vi.mocked(args.openContextAnswer).mock.calls[0][0];
  expect(captured.attachedAnnotationSelector).toEqual(selector);
  const catalog = buildConversationNoteCatalog({
    content,
    locale: 'en',
    annotationId: captured.attachedAnnotationId,
    annotationSelector: captured.attachedAnnotationSelector,
    hasExistingNote: true,
    selection: {
      selectedText: captured.selectedText,
      selectedTextStart: captured.selectedTextStart,
    },
  });
  const passage = catalog.entries.find(entry => entry.id === 's');
  if (!passage) throw new Error('Expected captured annotation target');
  expect(passage.hasExistingNote).toBe(true);
  expect(
    await result.current.handleUpdateConversationNote(
      { projectId: 'project-1', lessonId: 'lesson-1' },
      {
        ...passage.anchor,
        annotationId: passage.annotationId,
        note: 'Updated note',
        exactTarget: {
          content: passage.content,
          selector: passage.selector,
          segments: passage.segments,
        },
      }
    )
  ).toMatchObject({ saved: true, annotationId: 'attached', resolvedText: 'First sentence.' });
  expect(args.patchSectionAnnotations).toHaveBeenCalledWith(
    'lesson-1',
    [expect.objectContaining({ id: 'attached', note: 'Updated note', anchor: original.anchor })],
    undefined,
    undefined
  );
});
