import { beforeEach, describe, expect, test, vi } from 'vitest';

const callOpenRouterMock = vi.hoisted(() => vi.fn());

vi.mock('../../../services/openrouter/shared.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../services/openrouter/shared.ts')>();
  return {
    ...actual,
    callOpenRouter: callOpenRouterMock,
    retryWithBackoff: async <T>(operation: () => Promise<T>) => operation(),
  };
});

const { verifyLessonDraft } = await import('../../../services/openrouter/lessonVerification.ts');
const { repairLessonMarkdown } = await import(
  '../../../services/openrouter/lessonMarkdownQuality/repair.ts'
);

describe('lesson pipeline reasoning callbacks', () => {
  beforeEach(() => {
    callOpenRouterMock.mockReset();
  });

  test('forwards verification reasoning to generation progress', async () => {
    const onReasoningUpdate = vi.fn();
    callOpenRouterMock.mockResolvedValue(
      JSON.stringify({
        contentMarkdown: 'Contenuto verificato.',
        imagePlacements: [],
        quiz: [
          {
            correctIndex: 0,
            exerciseType: 'application-card',
            options: ['A', 'B', 'C', 'D'],
            question: 'Quale opzione si applica?',
          },
        ],
      })
    );

    await verifyLessonDraft({
      candidateImages: [],
      continuityRule: 'Mantieni la continuità.',
      draft: {
        contentMarkdown: 'Bozza.',
        imagePlacements: [],
        quiz: [],
      },
      onReasoningUpdate,
      previousContext: '',
      scopeRule: 'Resta nel tema.',
      sectionDescription: 'Descrizione',
      sectionTitle: 'Titolo',
      sourceContext: 'Fonte',
      targetQuizCount: 1,
    });

    expect(callOpenRouterMock.mock.calls[0]?.[0]?.onReasoningUpdate).toBe(onReasoningUpdate);
  });

  test('forwards repair reasoning to the quiz-phase progress stream', async () => {
    const onReasoningUpdate = vi.fn();
    callOpenRouterMock.mockResolvedValue('## Sezione corretta\n\nTesto corretto.');
    const malformedMarkdown = `${'# Titolo duplicato\n\n'.repeat(2)}${'Testo esteso. '.repeat(300)}`;

    await repairLessonMarkdown(
      malformedMarkdown,
      'Titolo',
      'Descrizione',
      'Fonte',
      undefined,
      onReasoningUpdate
    );

    expect(callOpenRouterMock.mock.calls[0]?.[0]?.onReasoningUpdate).toBe(onReasoningUpdate);
  });
});
