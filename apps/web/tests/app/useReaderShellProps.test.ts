import { describe, expect, test, vi } from 'vitest';
import { createGeneratedVisualRetryHandler } from '../../app/useReaderShellProps.ts';
import type {
  LessonGeneratedVisual,
  LessonGeneratedVisualBlock,
  LessonNode,
  LessonVisualRetryPlan,
} from '../../types.ts';

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

const buildVisual = (slotId: string): LessonGeneratedVisual => ({
  code: 'data:image/png;base64,AAAA',
  createdAt: '2026-07-26T00:00:00.000Z',
  id: `visual-${slotId}`,
  kind: 'image',
  title: `Visuale ${slotId}`,
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
    generationNotes: undefined,
    lessonWorkflowRequestId: 0,
    patchSectionLessonContent: vi.fn(
      async (_sectionId: string, _patch: Pick<LessonNode, 'contentBlocks' | 'generatedVisuals'>) =>
        true
    ),
    projectId: 'project-1' as string | null,
    sectionContent: section.content || '',
    updateSection: vi.fn(),
  };
  return {
    getContext: () => context,
    getSection: () => context.activeSection,
    patch: context.patchSectionLessonContent,
    replaceContext: (next: Partial<typeof context>) => {
      context = { ...context, ...next };
    },
    setCurrentSection: (nextSection: LessonNode) => {
      context = { ...context, activeSection: nextSection };
    },
    update: context.updateSection,
  };
};

describe('generated visual retry coordination', () => {
  test('serializes concurrent slots and preserves both successful results', async () => {
    const firstBlock = buildFailedBlock('slot-001');
    const secondBlock = buildFailedBlock('slot-002');
    const harness = createContextHarness(buildSection('slot-001', 'slot-002'));
    const retry = createGeneratedVisualRetryHandler({
      getContext: harness.getContext,
      retrySlot: vi.fn(async ({ plan }) => buildVisual(plan.slotId)),
      setCurrentSection: harness.setCurrentSection,
    });

    await expect(Promise.all([retry(firstBlock), retry(secondBlock)])).resolves.toEqual([
      true,
      true,
    ]);

    expect(harness.getSection()?.contentBlocks).toEqual([
      { slotId: 'slot-001', type: 'generated-visual', visualId: 'visual-slot-001' },
      { slotId: 'slot-002', type: 'generated-visual', visualId: 'visual-slot-002' },
    ]);
    expect(harness.getSection()?.generatedVisuals?.map(visual => visual.id)).toEqual([
      'visual-slot-001',
      'visual-slot-002',
    ]);
    expect(harness.patch).toHaveBeenCalledTimes(2);
    expect(harness.patch.mock.calls[1]?.[1].generatedVisuals).toHaveLength(2);
  });

  test('drops a completed provider result after navigation without persisting it', async () => {
    let finishRetry: ((visual: LessonGeneratedVisual) => void) | undefined;
    const harness = createContextHarness();
    const retry = createGeneratedVisualRetryHandler({
      getContext: harness.getContext,
      retrySlot: () =>
        new Promise(resolve => {
          finishRetry = resolve;
        }),
      setCurrentSection: harness.setCurrentSection,
    });

    const result = retry(buildFailedBlock('slot-001'));
    harness.replaceContext({ activeSectionId: 'lesson-2', projectId: 'project-2' });
    finishRetry?.(buildVisual('slot-001'));

    await expect(result).resolves.toBe(false);
    expect(harness.patch).not.toHaveBeenCalled();
    expect(harness.update).not.toHaveBeenCalled();
  });

  test('drops a completed provider result after the lesson workflow changes', async () => {
    let finishRetry: ((visual: LessonGeneratedVisual) => void) | undefined;
    const harness = createContextHarness();
    const retry = createGeneratedVisualRetryHandler({
      getContext: harness.getContext,
      retrySlot: () =>
        new Promise(resolve => {
          finishRetry = resolve;
        }),
      setCurrentSection: harness.setCurrentSection,
    });

    const result = retry(buildFailedBlock('slot-001'));
    harness.replaceContext({ lessonWorkflowRequestId: 1 });
    finishRetry?.(buildVisual('slot-001'));

    await expect(result).resolves.toBe(false);
    expect(harness.patch).not.toHaveBeenCalled();
    expect(harness.update).not.toHaveBeenCalled();
  });

  test('keeps the failed slot when persistence rejects the successful visual', async () => {
    const harness = createContextHarness();
    harness.patch.mockResolvedValueOnce(false);
    const retry = createGeneratedVisualRetryHandler({
      getContext: harness.getContext,
      retrySlot: vi.fn(async ({ plan }) => buildVisual(plan.slotId)),
      setCurrentSection: harness.setCurrentSection,
    });

    await expect(retry(buildFailedBlock('slot-001'))).resolves.toBe(false);
    expect(harness.getSection()?.contentBlocks?.[0]).toEqual(buildFailedBlock('slot-001'));
    expect(harness.update).not.toHaveBeenCalled();
  });
});
