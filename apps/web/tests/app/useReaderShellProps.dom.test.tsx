// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { useGeneratedVisualRetryCoordinator } from '../../app/useReaderShellProps.ts';
import type { LessonGeneratedVisualBlock, LessonNode } from '../../types.ts';

const failedVisual: LessonGeneratedVisualBlock = {
  retryPlan: {
    complexity: 'simple',
    concept: 'Concetto',
    coverage: 'single_complex',
    coverageRationale: 'Mostra il concetto.',
    factualRequirements: ['Requisito'],
    interactionLevel: 'none',
    pedagogicalGoal: 'Chiarire il concetto.',
    reason: 'Il testo non basta.',
    requiresDepiction: true,
    slotId: 'slot-001',
    visualDirection: 'Confronto affiancato.',
    visualType: 'illustrative_image',
  },
  slotId: 'slot-001',
  type: 'generated-visual',
};

const activeSection: LessonNode = {
  content: 'Lezione completa.',
  contentBlocks: [failedVisual],
  description: 'Descrizione',
  id: 'lesson-1',
  isCompleted: false,
  kind: 'lesson',
  title: 'Lezione',
  type: 'core',
};

test('aborts active visual polling when the mounted retry coordinator unmounts', async () => {
  let receivedSignal: AbortSignal | undefined;
  const retryVisual = vi.fn((_target, options) => {
    receivedSignal = options?.signal;
    return new Promise<never>((_resolve, reject) => {
      options?.signal?.addEventListener(
        'abort',
        () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        { once: true }
      );
    });
  });
  const context = {
    activeSection,
    activeSectionId: activeSection.id,
    applyPersistedProjectRevision: vi.fn(async () => true),
    lessonWorkflowRequestId: 0,
    projectId: 'project-1',
  };
  const { result, unmount } = renderHook(() =>
    useGeneratedVisualRetryCoordinator({ context, retryVisual })
  );

  const retry = result.current.retry(failedVisual);
  unmount();

  await expect(retry).resolves.toBe(false);
  expect(receivedSignal?.aborted).toBe(true);
  expect(context.applyPersistedProjectRevision).not.toHaveBeenCalled();
});
