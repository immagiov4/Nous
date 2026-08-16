// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { useWorkspaceReaderActions } from '../../../hooks/workspace/useWorkspaceReaderActions.ts';
import {
  LESSON_SOURCE_UNAVAILABLE_MESSAGE,
  LessonSourceUnavailableError,
} from '../../../services/openrouter/lessonGenerationClient.ts';

type HookArgs = Parameters<typeof useWorkspaceReaderActions>[0];

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
