import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { ExerciseDeliverableValidationResult } from '../../../services/exercises/deliverables.ts';
import type { ApplicationExerciseNode } from '../../../types.ts';

const callOpenRouterMock = vi.fn();

vi.mock('../../../services/openrouter/shared.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../services/openrouter/shared.ts')>();
  return {
    ...actual,
    callOpenRouter: callOpenRouterMock,
  };
});

const { generateApplicationExerciseFeedback } = await import(
  '../../../services/openrouter/exercises/evaluation.ts'
);

const exercise: ApplicationExerciseNode = {
  kind: 'exercise',
  id: 'exercise-1',
  title: 'Analisi applicata',
  description: 'Consegna una diagnosi motivata.',
  assessedObjective: 'Collegare le prove alle conclusioni.',
  attachments: [],
  currentFeedback: null,
  isCompleted: false,
  feedbackStale: false,
  updatedAt: '2026-07-10T09:00:00.000Z',
};

const deliverable: ExerciseDeliverableValidationResult = {
  dropped: [],
  entries: [
    {
      path: 'diagnosi.md',
      text: 'La conclusione deriva dai dati osservati nel campione A-17.',
      truncated: false,
    },
  ],
  totalChars: 62,
  truncations: [],
};

const generateFeedback = () =>
  generateApplicationExerciseFeedback({
    deliverable,
    exercise,
    profile: null,
  });

beforeEach(() => {
  callOpenRouterMock.mockReset();
});

test('generateApplicationExerciseFeedback evaluates the validated deliverable and normalizes the model result', async () => {
  callOpenRouterMock.mockResolvedValue(
    JSON.stringify({
      scorePercent: 104.6,
      qualitativeLabel: '  Ottimo lavoro  ',
      summary: '  Le conclusioni sono sostenute dalle prove.  ',
      strengths: ['  Dati citati  ', '', 42, 'Conclusione verificabile'],
      improvements: 'Aggiungi un confronto',
      caveats: ['  Campione limitato  ', null],
    })
  );

  const feedback = await generateFeedback();
  const request = callOpenRouterMock.mock.calls[0]?.[0];
  const userMessage = request?.messages?.find(
    (message: { role?: string }) => message.role === 'user'
  )?.content;

  assert.equal(typeof userMessage, 'string');
  assert.match(userMessage, /diagnosi\.md/);
  assert.match(userMessage, /La conclusione deriva dai dati osservati nel campione A-17\./);
  assert.match(userMessage, /Numero totale di parole: 9/);
  assert.equal(request?.response_format?.type, 'json_schema');
  assert.equal(feedback.score, 100);
  assert.equal(feedback.qualitativeLabel, 'Ottimo lavoro');
  assert.equal(feedback.summary, 'Le conclusioni sono sostenute dalle prove.');
  assert.deepEqual(feedback.strengths, ['Dati citati', 'Conclusione verificabile']);
  assert.deepEqual(feedback.improvements, []);
  assert.deepEqual(feedback.caveats, ['Campione limitato']);
  assert.equal(Number.isNaN(Date.parse(feedback.evaluatedAt)), false);
});

test('generateApplicationExerciseFeedback rejects missing or non-numeric percentage scores', async () => {
  for (const scorePercent of [undefined, '90']) {
    callOpenRouterMock.mockResolvedValueOnce(
      JSON.stringify({
        scorePercent,
        summary: 'La consegna e stata valutata.',
      })
    );

    await assert.rejects(generateFeedback, Error);
  }
});

test('generateApplicationExerciseFeedback rejects an invalid summary', async () => {
  for (const summary of [undefined, '   ', { text: 'Non e una stringa' }]) {
    callOpenRouterMock.mockResolvedValueOnce(
      JSON.stringify({
        scorePercent: 75,
        summary,
      })
    );

    await assert.rejects(generateFeedback, Error);
  }
});
