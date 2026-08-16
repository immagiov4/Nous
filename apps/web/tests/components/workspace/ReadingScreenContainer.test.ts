// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from 'vitest';

const annotationHighlightMocks = vi.hoisted(() => ({
  resolveTarget: vi.fn(),
  setHit: vi.fn(),
}));

vi.mock('../../../utils/learning/sectionAnnotationHighlights.ts', async importOriginal => ({
  ...(await importOriginal<
    typeof import('../../../utils/learning/sectionAnnotationHighlights.ts')
  >()),
  resolveActiveSectionAnnotationHighlightTarget: annotationHighlightMocks.resolveTarget,
  setSectionAnnotationHighlightHit: annotationHighlightMocks.setHit,
}));

import {
  navigateToLibraryReference,
  revealLibraryAnnotation,
} from '../../../components/workspace/ReadingScreenContainer.tsx';
import { buildTestLearningPlan, buildTestLesson } from '../../helpers/learningPlan.ts';

type NavigationDependencies = Parameters<typeof navigateToLibraryReference>[1];
let animationFrameCallbacks: FrameRequestCallback[];

beforeEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
  animationFrameCallbacks = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    animationFrameCallbacks.push(callback);
    return animationFrameCallbacks.length;
  });
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value },
  });
});

const runNextAnimationFrame = () => {
  const callback = animationFrameCallbacks.shift();
  expect(callback).toBeDefined();
  callback?.(0);
};

const createNavigationHarness = (overrides: Partial<NavigationDependencies> = {}) => {
  const cancelContextAnswerLessonRetention = vi.fn();
  const cancelPendingProjectOpen = vi.fn();
  const clearPendingReference = vi.fn();
  const closeContextAnswer = vi.fn();
  const openProject = vi.fn(async () => ({ outcome: 'opened' }));
  const openSection = vi.fn(async () => 'loaded' as const);
  const reportFailure = vi.fn();
  const retainContextAnswerForLesson = vi.fn();
  const revealAnnotation = vi.fn();
  const dependencies: NavigationDependencies = {
    activeSectionId: 'lesson-1',
    cancelContextAnswerLessonRetention,
    cancelPendingProjectOpen,
    clearPendingReference,
    closeContextAnswer,
    currentProjectId: 'project-current',
    isCurrentRequest: () => true,
    isSectionLoadPending: false,
    learningPlan: buildTestLearningPlan([
      buildTestLesson({ id: 'lesson-1' }),
      buildTestLesson({ id: 'lesson-2' }),
    ]),
    openProject,
    openSection,
    reportFailure,
    retainContextAnswerForLesson,
    revealAnnotation,
    ...overrides,
  };
  return {
    cancelContextAnswerLessonRetention,
    cancelPendingProjectOpen,
    clearPendingReference,
    closeContextAnswer,
    dependencies,
    openProject,
    openSection,
    reportFailure,
    retainContextAnswerForLesson,
    revealAnnotation,
  };
};

test('opens a cross-course lesson at the requested target', async () => {
  const harness = createNavigationHarness();

  await navigateToLibraryReference(
    {
      kind: 'lesson',
      lessonId: 'lesson-other',
      projectId: 'project-other',
      projectTitle: 'Altro corso',
    },
    harness.dependencies
  );

  expect(harness.openProject).toHaveBeenCalledWith('project-other', {
    activeSectionId: 'lesson-other',
    source: 'library',
  });
  expect(harness.retainContextAnswerForLesson).toHaveBeenCalledWith('lesson-other');
  expect(harness.cancelContextAnswerLessonRetention).not.toHaveBeenCalled();
  expect(harness.closeContextAnswer).not.toHaveBeenCalled();
});

test('closes the retained answer after opening a cross-course project reference', async () => {
  const harness = createNavigationHarness();

  await navigateToLibraryReference(
    { kind: 'project', projectId: 'project-other', projectTitle: 'Altro corso' },
    harness.dependencies
  );

  expect(harness.openProject).toHaveBeenCalledOnce();
  expect(harness.closeContextAnswer).toHaveBeenCalledOnce();
  expect(harness.retainContextAnswerForLesson).not.toHaveBeenCalled();
});

test.each([
  ['failed', 'clear'] as const,
  ['stale', 'clear'] as const,
  ['missing', 'report'] as const,
])('handles a cross-course %s project-open outcome', async (outcome, action) => {
  const harness = createNavigationHarness({
    openProject: vi.fn(async () => ({ outcome })),
  });

  await navigateToLibraryReference(
    { kind: 'project', projectId: 'project-other', projectTitle: 'Altro corso' },
    harness.dependencies
  );

  expect(harness.clearPendingReference).toHaveBeenCalledTimes(action === 'clear' ? 1 : 0);
  expect(harness.reportFailure).toHaveBeenCalledTimes(action === 'report' ? 1 : 0);
  expect(harness.cancelContextAnswerLessonRetention).toHaveBeenCalledOnce();
});

test('rejects cross-course navigation while a section is loading', async () => {
  const harness = createNavigationHarness({ isSectionLoadPending: true });

  await navigateToLibraryReference(
    { kind: 'project', projectId: 'project-other', projectTitle: 'Altro corso' },
    harness.dependencies
  );

  expect(harness.reportFailure).toHaveBeenCalledWith();
  expect(harness.openProject).not.toHaveBeenCalled();
});

test('reveals an annotation in the active lesson', async () => {
  const harness = createNavigationHarness();

  await navigateToLibraryReference(
    {
      annotationId: 'annotation-1',
      kind: 'annotation',
      lessonId: 'lesson-1',
      projectId: 'project-current',
      projectTitle: 'Corso corrente',
    },
    harness.dependencies
  );

  expect(harness.openSection).not.toHaveBeenCalled();
  expect(harness.cancelPendingProjectOpen).toHaveBeenCalledOnce();
  expect(harness.revealAnnotation).toHaveBeenCalledOnce();
  expect(harness.closeContextAnswer).not.toHaveBeenCalled();
});

test('closes the retained answer when the active lesson reference has no annotation target', async () => {
  const harness = createNavigationHarness();

  await navigateToLibraryReference(
    {
      kind: 'lesson',
      lessonId: 'lesson-1',
      projectId: 'project-current',
      projectTitle: 'Corso corrente',
    },
    harness.dependencies
  );

  expect(harness.openSection).not.toHaveBeenCalled();
  expect(harness.revealAnnotation).not.toHaveBeenCalled();
  expect(harness.closeContextAnswer).toHaveBeenCalledOnce();
});

test('closes the retained answer for a current-course reference without a lesson target', async () => {
  const harness = createNavigationHarness();

  await navigateToLibraryReference(
    { kind: 'project', projectId: 'project-current', projectTitle: 'Corso corrente' },
    harness.dependencies
  );

  expect(harness.openSection).not.toHaveBeenCalled();
  expect(harness.closeContextAnswer).toHaveBeenCalledOnce();
});

test('does not reveal an active-lesson reference after its request is superseded', async () => {
  const harness = createNavigationHarness({ isCurrentRequest: () => false });

  await navigateToLibraryReference(
    {
      kind: 'lesson',
      lessonId: 'lesson-1',
      projectId: 'project-current',
      projectTitle: 'Corso corrente',
    },
    harness.dependencies
  );

  expect(harness.revealAnnotation).not.toHaveBeenCalled();
});

test('opens and reveals a reference in another lesson of the current course', async () => {
  const harness = createNavigationHarness();

  await navigateToLibraryReference(
    {
      kind: 'lesson',
      lessonId: 'lesson-2',
      projectId: 'project-current',
      projectTitle: 'Corso corrente',
    },
    harness.dependencies
  );

  expect(harness.openSection).toHaveBeenCalledWith(expect.objectContaining({ id: 'lesson-2' }));
  expect(harness.retainContextAnswerForLesson).toHaveBeenCalledWith('lesson-2');
  expect(harness.revealAnnotation).toHaveBeenCalledOnce();
});

test.each([
  {
    reference: {
      kind: 'lesson' as const,
      lessonId: 'lesson-missing',
      projectId: 'project-current',
      projectTitle: 'Corso corrente',
    },
  },
  {
    openSection: vi.fn(async () => 'ignored-busy' as const),
    reference: {
      kind: 'lesson' as const,
      lessonId: 'lesson-2',
      projectId: 'project-current',
      projectTitle: 'Corso corrente',
    },
  },
])('reports a current-course reference that cannot be opened', async options => {
  const harness = createNavigationHarness({ openSection: options.openSection });

  await navigateToLibraryReference(options.reference, harness.dependencies);

  expect(harness.reportFailure).toHaveBeenCalledWith();
  expect(harness.cancelContextAnswerLessonRetention).toHaveBeenCalledTimes(
    options.openSection ? 1 : 0
  );
});

test('does not finish a superseded navigation request', async () => {
  const harness = createNavigationHarness({ isCurrentRequest: () => false });

  await navigateToLibraryReference(
    {
      kind: 'lesson',
      lessonId: 'lesson-2',
      projectId: 'project-current',
      projectTitle: 'Corso corrente',
    },
    harness.dependencies
  );

  expect(harness.openSection).toHaveBeenCalledOnce();
  expect(harness.cancelContextAnswerLessonRetention).toHaveBeenCalledOnce();
  expect(harness.revealAnnotation).not.toHaveBeenCalled();
});

test('does not reveal a superseded cross-course request', async () => {
  const harness = createNavigationHarness({ isCurrentRequest: () => false });

  await navigateToLibraryReference(
    { kind: 'project', projectId: 'project-other', projectTitle: 'Altro corso' },
    harness.dependencies
  );

  expect(harness.openProject).toHaveBeenCalledOnce();
  expect(harness.closeContextAnswer).not.toHaveBeenCalled();
});

test('reports unexpected navigation failures', async () => {
  const error = new Error('navigation unavailable');
  const harness = createNavigationHarness({
    openProject: vi.fn(async () => {
      throw error;
    }),
  });

  await navigateToLibraryReference(
    { kind: 'project', projectId: 'project-other', projectTitle: 'Altro corso' },
    harness.dependencies
  );

  expect(harness.reportFailure).toHaveBeenCalledWith(error);
  expect(harness.cancelContextAnswerLessonRetention).toHaveBeenCalledOnce();
});

test('reveals an annotation rendered as a mark', () => {
  const mark = document.createElement('mark');
  mark.dataset.nousAnnotationId = 'annotation-mark';
  const scrollIntoView = vi.fn();
  mark.scrollIntoView = scrollIntoView;
  const onClick = vi.fn();
  mark.addEventListener('click', onClick);
  document.body.append(mark);

  expect(revealLibraryAnnotation('annotation-mark')).toBe(true);

  expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' });
  expect(onClick).not.toHaveBeenCalled();
  runNextAnimationFrame();
  expect(onClick).toHaveBeenCalledOnce();
  expect(annotationHighlightMocks.resolveTarget).not.toHaveBeenCalled();
});

test('reveals a native annotation highlight and attaches its hit to the click', () => {
  const element = document.createElement('p');
  const scrollIntoView = vi.fn();
  element.scrollIntoView = scrollIntoView;
  const onClick = vi.fn();
  element.addEventListener('click', onClick);
  const initialHit = {
    annotationId: 'annotation-native',
    rect: new DOMRect(10, 20, 120, 18),
    selectedText: 'Testo evidenziato',
  };
  const revealedHit = {
    ...initialHit,
    rect: new DOMRect(30, 40, 120, 18),
  };
  annotationHighlightMocks.resolveTarget
    .mockReturnValueOnce({ element, hit: initialHit })
    .mockReturnValueOnce({ element, hit: revealedHit });

  expect(revealLibraryAnnotation('annotation-native')).toBe(true);

  expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' });
  expect(annotationHighlightMocks.resolveTarget).toHaveBeenCalledOnce();
  expect(onClick).not.toHaveBeenCalled();
  runNextAnimationFrame();
  expect(annotationHighlightMocks.resolveTarget).toHaveBeenCalledTimes(2);
  expect(annotationHighlightMocks.setHit).toHaveBeenCalledWith(expect.any(MouseEvent), revealedHit);
  expect(onClick).toHaveBeenCalledOnce();
});

test('uses the original native highlight if projection changes after scrolling', () => {
  const element = document.createElement('p');
  element.scrollIntoView = vi.fn();
  const hit = {
    annotationId: 'annotation-native',
    rect: new DOMRect(10, 20, 120, 18),
    selectedText: 'Testo evidenziato',
  };
  annotationHighlightMocks.resolveTarget
    .mockReturnValueOnce({ element, hit })
    .mockReturnValueOnce(null);

  expect(revealLibraryAnnotation('annotation-native')).toBe(true);

  runNextAnimationFrame();
  expect(annotationHighlightMocks.setHit).toHaveBeenCalledWith(expect.any(MouseEvent), hit);
});

test('leaves a missing annotation pending', () => {
  annotationHighlightMocks.resolveTarget.mockReturnValue(null);

  expect(revealLibraryAnnotation('annotation-missing')).toBe(false);

  expect(annotationHighlightMocks.setHit).not.toHaveBeenCalled();
});
