import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type { QuizQuestion } from '../../../types.ts';
import { hasExactInlineQuizMarkerContract } from '../../../utils/reader/inlineQuiz.ts';

const repairLessonMarkdownMock = vi.fn();
const verifyLessonDraftMock = vi.fn();
const materializeGeneratedVisualSlotsMock = vi.fn(
  async ({ contentMarkdown }: { contentMarkdown: string }) => ({
    content: contentMarkdown,
    generatedVisualSlots: [],
    generatedVisuals: [],
    visualPlanningDecision: {
      initial: { outcome: 'none' as const, plans: [], rationale: 'Nessuna visuale.' },
      reviewed: { outcome: 'none' as const, plans: [], rationale: 'Nessuna visuale.' },
      reviewedAt: '2026-07-22T00:00:00.000Z',
    },
  })
);

vi.mock('../../../services/openrouter/lessonMarkdownQuality/index.ts', async importOriginal => {
  const actual =
    await importOriginal<
      typeof import('../../../services/openrouter/lessonMarkdownQuality/index.ts')
    >();
  return {
    ...actual,
    repairLessonMarkdown: repairLessonMarkdownMock,
    sanitizeLessonMarkdownContent: (content: string) => content,
  };
});

vi.mock('../../../services/openrouter/lessonVerification.ts', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../../services/openrouter/lessonVerification.ts')>();
  return {
    ...actual,
    verifyLessonDraft: verifyLessonDraftMock,
  };
});

vi.mock('../../../services/openrouter/lessonImages.ts', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../../services/openrouter/lessonImages.ts')>();
  return {
    ...actual,
    materializeGeneratedVisualSlots: materializeGeneratedVisualSlotsMock,
  };
});

vi.mock('../../../services/openrouter/learningAids.ts', () => ({
  generateLessonLearningAids: async () => [],
}));

const { finalizeSourceFreeLesson } = await import(
  '../../../services/openrouter/sourceFreeLessonFinalization.ts'
);

test('finalizeSourceFreeLesson falls back to the original validated lesson and quiz pair', async () => {
  repairLessonMarkdownMock.mockReset();
  verifyLessonDraftMock.mockReset();
  materializeGeneratedVisualSlotsMock.mockClear();

  const originalContent =
    '## Concetto\n\nSpiegazione completa.\n\n{{INLINE_QUIZ:0}}\n\nConclusione.';
  const repairedContentWithLostMarker = '## Concetto\n\nSpiegazione corretta.\n\nConclusione.';
  const quiz: QuizQuestion[] = [
    {
      question: 'Applica il concetto.',
      options: ['A', 'B', 'C', 'D'],
      correctIndex: 0,
    },
  ];
  repairLessonMarkdownMock.mockResolvedValue(repairedContentWithLostMarker);
  verifyLessonDraftMock.mockRejectedValue(new Error('verification failed'));

  const result = await finalizeSourceFreeLesson({
    contentMarkdown: originalContent,
    quiz,
    sectionDescription: 'Applicazione del concetto.',
    sectionTitle: 'Concetto',
  });

  assert.equal(result.content, originalContent);
  assert.equal(result.quiz, quiz);
  assert.equal(hasExactInlineQuizMarkerContract(result.content, result.quiz.length), true);
});

test('finalizeSourceFreeLesson preserves a valid lesson without active pauses', async () => {
  repairLessonMarkdownMock.mockReset();
  verifyLessonDraftMock.mockReset();
  materializeGeneratedVisualSlotsMock.mockClear();

  const contentBlocks = [
    { markdown: '## Concetto\n\nSpiegazione completa.', type: 'markdown' as const },
    { markdown: '## Conclusione\n\nApplicazione conclusiva.', type: 'markdown' as const },
  ];
  const contentMarkdown = contentBlocks.map(block => block.markdown).join('\n\n');
  verifyLessonDraftMock.mockResolvedValue({
    contentBlocks,
    contentMarkdown,
    imagePlacements: [],
    quiz: [],
    visualPlanning: { plans: [], rationale: 'Nessun visuale.' },
  });

  const result = await finalizeSourceFreeLesson({
    contentBlocks,
    contentMarkdown,
    sectionDescription: 'Applicazione del concetto.',
    sectionTitle: 'Concetto',
  });

  assert.deepEqual(result.quiz, []);
  assert.deepEqual(result.contentBlocks, contentBlocks);
});
