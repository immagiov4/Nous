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

const { buildLessonVerificationPrompt, parseLessonContentPayload, verifyLessonDraft } =
  await import('../../../services/openrouter/lessonVerification.ts');
const { repairLessonMarkdown } = await import(
  '../../../services/openrouter/lessonMarkdownQuality/repair.ts'
);
const { buildLessonVerificationChecklist } = await import(
  '../../../utils/learning/lessonInstructionPacks.ts'
);

describe('lesson pipeline reasoning callbacks', () => {
  beforeEach(() => {
    callOpenRouterMock.mockReset();
  });

  test('forwards verification reasoning to generation progress', async () => {
    const onReasoningUpdate = vi.fn();
    callOpenRouterMock.mockResolvedValue(
      JSON.stringify({
        contentBlocks: [
          { markdown: 'Contenuto verificato.', type: 'markdown' },
          {
            type: 'inline-quiz',
            quiz: {
              correctIndex: 0,
              exerciseType: 'application-card',
              options: ['A', 'B', 'C', 'D'],
              question: 'Quale opzione si applica?',
            },
          },
        ],
        imagePlacements: [],
        verificationReport: buildLessonVerificationChecklist([]).map(check => ({
          action: '',
          checkId: check.checkId,
          evidence: 'Controllo completato sulla bozza.',
          status: 'pass',
        })),
        visualPlanning: { plans: [], rationale: 'Nessun visuale.' },
      })
    );

    await verifyLessonDraft({
      candidateImages: [],
      continuityRule: 'Mantieni la continuità.',
      draft: {
        contentMarkdown: 'Bozza.',
        imagePlacements: [],
        quiz: [],
        visualPlanning: { plans: [], rationale: 'Nessun visuale.' },
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

  test('allows verification to remove every active pause when none merits interruption', async () => {
    callOpenRouterMock.mockResolvedValue(
      JSON.stringify({
        contentBlocks: [
          { markdown: '## Concetto\n\nSpiegazione completa.', type: 'markdown' },
          { markdown: '## Conclusione\n\nApplicazione conclusiva.', type: 'markdown' },
        ],
        imagePlacements: [],
        verificationReport: buildLessonVerificationChecklist([]).map(check => ({
          action: '',
          checkId: check.checkId,
          evidence: 'Controllo completato sulla bozza.',
          status: 'pass',
        })),
        visualPlanning: { plans: [], rationale: 'Nessun visuale.' },
      })
    );

    const verified = await verifyLessonDraft({
      candidateImages: [],
      continuityRule: 'Mantieni la continuita.',
      draft: {
        contentMarkdown: 'Bozza.',
        imagePlacements: [],
        quiz: [],
        visualPlanning: { plans: [], rationale: 'Nessun visuale.' },
      },
      previousContext: '',
      scopeRule: 'Resta nel tema.',
      sectionDescription: 'Descrizione',
      sectionTitle: 'Titolo',
      sourceContext: 'Fonte',
      targetQuizCount: 1,
    });

    expect(verified.quiz).toEqual([]);
    expect(verified.contentBlocks).toHaveLength(2);
  });

  test('forwards repair reasoning to the quiz-phase progress stream', async () => {
    const onReasoningUpdate = vi.fn();
    callOpenRouterMock.mockResolvedValue('## Sezione corretta\n\nTesto corretto.');
    const malformedMarkdown = '## Formula\n\n[\nx + y\n]';

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

  test('rejects typed quiz blocks without preceding lesson content', () => {
    expect(() =>
      parseLessonContentPayload(
        JSON.stringify({
          contentBlocks: [
            {
              type: 'inline-quiz',
              quiz: {
                correctIndex: 0,
                exerciseType: 'application-card',
                options: ['A', 'B', 'C', 'D'],
                question: 'Quale opzione si applica?',
              },
            },
          ],
          imagePlacements: [],
          visualPlanning: { plans: [], rationale: 'Nessun visuale.' },
        }),
        'Titolo'
      )
    ).toThrow(/contratto dei blocchi quiz inline/);
  });

  test('accepts a typed lesson without active pauses', () => {
    const parsed = parseLessonContentPayload(
      JSON.stringify({
        contentBlocks: [
          { markdown: '## Concetto\n\nSpiegazione completa.', type: 'markdown' },
          { markdown: '## Conclusione\n\nApplicazione conclusiva.', type: 'markdown' },
        ],
        imagePlacements: [],
        visualPlanning: { plans: [], rationale: 'Nessun visuale.' },
      }),
      'Titolo'
    );

    expect(parsed.quiz).toEqual([]);
  });

  test('keeps the complete backend-bounded source context available to verification', () => {
    const transcriptTail = '[12:10-12:30] Mostra il passaggio pratico completo.';
    const sourceContext = `${'Contesto precedente. '.repeat(1_500)}${transcriptTail}`;
    const prompt = buildLessonVerificationPrompt({
      candidateImages: [],
      continuityRule: 'Mantieni la continuità.',
      draft: {
        contentMarkdown: 'Bozza.',
        imagePlacements: [],
        quiz: [],
        visualPlanning: { plans: [], rationale: 'Nessun visuale.' },
      },
      previousContext: '',
      scopeRule: 'Resta nel tema.',
      sectionDescription: 'Descrizione',
      sectionTitle: 'Titolo',
      sourceContext,
      targetQuizCount: 1,
    });

    expect(sourceContext.length).toBeGreaterThan(24_000);
    expect(prompt).toContain(transcriptTail);
  });

  test('activates only the selected specialist checklist', () => {
    const prompt = buildLessonVerificationPrompt({
      candidateImages: [],
      continuityRule: 'Mantieni la continuità.',
      draft: {
        contentMarkdown: 'Bozza.',
        imagePlacements: [],
        quiz: [],
        visualPlanning: { plans: [], rationale: 'Nessun visuale.' },
      },
      instructionPacks: ['mathematics'],
      previousContext: '',
      scopeRule: 'Resta nel tema.',
      sectionDescription: 'Descrizione',
      sectionTitle: 'Titolo',
      sourceContext: 'Fonte',
      targetQuizCount: 1,
    });

    expect(prompt).toContain('mathematics.1');
    expect(prompt).not.toContain('code.1');
    expect(prompt).toContain('stesso paragrafo o in quello immediatamente successivo');
  });
});
