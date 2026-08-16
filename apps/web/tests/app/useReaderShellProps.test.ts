import { describe, expect, test, vi } from 'vitest';
import {
  createGeneratedVisualRetryCoordinator,
  loadStoredDocumentSourceFile,
} from '../../app/useReaderShellProps.ts';
import { ProjectStorageError } from '../../services/projects/projectRepository.ts';
import type { LessonGeneratedVisualBlock, LessonNode, LessonVisualRetryPlan } from '../../types.ts';

const buildPlan = (slotId: string): LessonVisualRetryPlan => ({
  slotId,
  complexity: 'simple',
  concept: `Concetto ${slotId}`,
  coverage: 'single_complex',
  coverageRationale: 'Mostra il concetto.',
  factualRequirements: ['Requisito'],
  interactionLevel: 'none',
  pedagogicalGoal: 'Chiarire il concetto.',
  reason: 'Il testo non basta.',
  requiresDepiction: true,
  visualDirection: 'Confronto affiancato.',
  visualType: 'illustrative_image',
});

const buildFailedBlock = (slotId: string): LessonGeneratedVisualBlock => ({
  retryPlan: buildPlan(slotId),
  slotId,
  type: 'generated-visual',
});

const buildSection = (...slotIds: string[]): LessonNode => ({
  content: 'Lezione completa.',
  contentBlocks: slotIds.map(buildFailedBlock),
  description: 'Descrizione',
  generatedVisuals: [],
  id: 'lesson-1',
  isCompleted: false,
  kind: 'lesson',
  title: 'Lezione',
  type: 'core',
});

const createContextHarness = (section = buildSection('slot-001')) => {
  let context = {
    activeSection: section as LessonNode | null,
    activeSectionId: section.id as string | null,
    applyPersistedProjectRevision: vi.fn(async () => true),
    lessonWorkflowRequestId: 0,
    projectId: 'project-1' as string | null,
  };
  return {
    applyRevision: context.applyPersistedProjectRevision,
    getContext: () => context,
    replaceContext: (next: Partial<typeof context>) => {
      context = { ...context, ...next };
    },
  };
};

const createRetryHarness = (
  contextHarness: ReturnType<typeof createContextHarness>,
  retryVisual: Parameters<typeof createGeneratedVisualRetryCoordinator>[0]['retryVisual']
) => {
  const coordinator = createGeneratedVisualRetryCoordinator({
    initialContext: contextHarness.getContext(),
    retryVisual,
  });
  return {
    replaceContext: (
      next: Parameters<ReturnType<typeof createContextHarness>['replaceContext']>[0]
    ) => {
      contextHarness.replaceContext(next);
      coordinator.setContext(contextHarness.getContext());
    },
    retry: coordinator.retry,
  };
};

describe('generated visual retry coordination', () => {
  test('runs different slots concurrently and hydrates each committed revision', async () => {
    const harness = createContextHarness(buildSection('slot-001', 'slot-002'));
    const retryVisual = vi
      .fn()
      .mockResolvedValueOnce({ projectRevision: 6 })
      .mockResolvedValueOnce({ projectRevision: 7 });
    const { retry } = createRetryHarness(harness, retryVisual);

    await expect(
      Promise.all([retry(buildFailedBlock('slot-001')), retry(buildFailedBlock('slot-002'))])
    ).resolves.toEqual([true, true]);

    expect(retryVisual).toHaveBeenCalledTimes(2);
    expect(retryVisual).toHaveBeenNthCalledWith(
      1,
      {
        projectId: 'project-1',
        sectionId: 'lesson-1',
        slotId: 'slot-001',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(retryVisual).toHaveBeenNthCalledWith(
      2,
      {
        projectId: 'project-1',
        sectionId: 'lesson-1',
        slotId: 'slot-002',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(harness.applyRevision).toHaveBeenCalledWith({ projectId: 'project-1', revision: 6 });
    expect(harness.applyRevision).toHaveBeenCalledWith({ projectId: 'project-1', revision: 7 });
  });

  test('does not hydrate a completed backend retry after navigation', async () => {
    let finishRetry: ((result: { projectRevision: number }) => void) | undefined;
    const harness = createContextHarness();
    const coordinator = createRetryHarness(
      harness,
      () =>
        new Promise(resolve => {
          finishRetry = resolve;
        })
    );

    const result = coordinator.retry(buildFailedBlock('slot-001'));
    coordinator.replaceContext({ activeSectionId: 'lesson-2', projectId: 'project-2' });
    finishRetry?.({ projectRevision: 6 });

    await expect(result).resolves.toBe(false);
    expect(harness.applyRevision).not.toHaveBeenCalled();
  });

  test('does not hydrate after a newer lesson workflow takes ownership', async () => {
    let finishRetry: ((result: { projectRevision: number }) => void) | undefined;
    const harness = createContextHarness();
    const coordinator = createRetryHarness(
      harness,
      () =>
        new Promise(resolve => {
          finishRetry = resolve;
        })
    );

    const result = coordinator.retry(buildFailedBlock('slot-001'));
    coordinator.replaceContext({ lessonWorkflowRequestId: 1 });
    finishRetry?.({ projectRevision: 6 });

    await expect(result).resolves.toBe(false);
    expect(harness.applyRevision).not.toHaveBeenCalled();
  });

  test('reports failure when the authoritative revision cannot be hydrated', async () => {
    const harness = createContextHarness();
    harness.applyRevision.mockResolvedValueOnce(false);
    const { retry } = createRetryHarness(
      harness,
      vi.fn(async () => ({ projectRevision: 6 }))
    );

    await expect(retry(buildFailedBlock('slot-001'))).resolves.toBe(false);
  });

  test('shares one in-flight retry for repeated clicks on the same slot', async () => {
    const harness = createContextHarness();
    const retryVisual = vi.fn(async () => ({ projectRevision: 6 }));
    const { retry } = createRetryHarness(harness, retryVisual);
    const block = buildFailedBlock('slot-001');

    await expect(Promise.all([retry(block), retry(block)])).resolves.toEqual([true, true]);
    expect(retryVisual).toHaveBeenCalledOnce();
    expect(harness.applyRevision).toHaveBeenCalledOnce();
  });

  test('aborts browser polling when navigation makes a retry irrelevant', async () => {
    const harness = createContextHarness();
    let receivedSignal: AbortSignal | undefined;
    const coordinator = createRetryHarness(harness, (_target, options) => {
      receivedSignal = options?.signal;
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
          once: true,
        });
      });
    });

    const result = coordinator.retry(buildFailedBlock('slot-001'));
    coordinator.replaceContext({ activeSectionId: 'lesson-2' });

    await expect(result).resolves.toBe(false);
    expect(receivedSignal?.aborted).toBe(true);
    expect(harness.applyRevision).not.toHaveBeenCalled();
  });
});

describe('stored document source loading', () => {
  test('falls back to the legacy bulk endpoint only when the source endpoint is unavailable', async () => {
    const loadSources = vi.fn(async () => [
      {
        file: { data: 'cGRm', mimeType: 'application/pdf', name: '049.pdf' },
        ref: {
          byteSize: 3,
          hash: 'source-hash',
          id: 'source-049',
          mimeType: 'application/pdf',
          name: '049.pdf',
          objectPath: 'sources/049.pdf',
        },
      },
    ]);

    await expect(
      loadStoredDocumentSourceFile({
        loadPrimarySource: vi.fn(),
        loadSourceById: vi.fn(async () => {
          throw new ProjectStorageError('Not found', 'unknown', { status: 404 });
        }),
        loadSources,
        sourceId: 'source-049',
        usePrimarySource: false,
      })
    ).resolves.toMatchObject({ name: '049.pdf' });
    expect(loadSources).toHaveBeenCalledOnce();
  });

  test('does not hide failures from the per-source endpoint', async () => {
    const loadSources = vi.fn();

    await expect(
      loadStoredDocumentSourceFile({
        loadPrimarySource: vi.fn(),
        loadSourceById: vi.fn(async () => {
          throw new ProjectStorageError('Unavailable', 'unknown', { status: 503 });
        }),
        loadSources,
        sourceId: 'source-049',
        usePrimarySource: false,
      })
    ).rejects.toMatchObject({ httpStatus: 503 });
    expect(loadSources).not.toHaveBeenCalled();
  });
});
