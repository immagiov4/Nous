import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { ApplicationExerciseNode, LearningPlan } from '../../../types.ts';
import { buildTestLearningPlan, buildTestLesson } from '../../helpers/learningPlan.ts';

const callOpenRouterMock = vi.fn();
const retryWithBackoffMock = vi.fn(async <T>(operation: () => Promise<T>) => await operation());

vi.mock('../../../services/openrouter/shared.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../services/openrouter/shared.ts')>();
  return {
    ...actual,
    callOpenRouter: callOpenRouterMock,
    retryWithBackoff: retryWithBackoffMock,
  };
});

const { generateApplicationExerciseBrief } = await import(
  '../../../services/openrouter/exercises/brief.ts'
);

const exercise: ApplicationExerciseNode = {
  kind: 'exercise',
  id: 'exercise-1',
  title: 'Smontare un messaggio persuasivo',
  description: 'Analizza fonte, argomenti e destinatari di un messaggio.',
  assessedObjective: 'Motivare quali elementi aumentano o riducono la persuasione.',
  attachments: [],
  currentFeedback: null,
  isCompleted: false,
  feedbackStale: false,
  updatedAt: '2026-07-09T18:00:00.000Z',
};

const buildPlanWithExercise = (): LearningPlan => {
  const plan = buildTestLearningPlan([
    buildTestLesson({
      content: 'Una fonte credibile e un messaggio a due facce possono influire sulla persuasione.',
      description: 'Credibilità, argomenti e destinatari.',
      title: 'Struttura dei messaggi persuasivi',
    }),
  ]);
  const module = plan.modules[0];
  assert.ok(module);

  return {
    ...plan,
    modules: [{ ...module, children: [...module.children, exercise] }],
  };
};

beforeEach(() => {
  callOpenRouterMock.mockReset();
  retryWithBackoffMock.mockClear();
});

test('application exercise brief removes a redundant final-delivery section', async () => {
  callOpenRouterMock.mockResolvedValue(
    JSON.stringify({
      briefMarkdown: `## Scenario

Analizza il messaggio fornito.

## Cosa devi consegnare

Un report in tre parti.

## Consegna finale attesa

Un report breve e ordinato.

## Come verrà verificato

La diagnosi deve citare elementi osservabili.`,
    })
  );

  const result = await generateApplicationExerciseBrief({
    exercise,
    learningPlan: buildPlanWithExercise(),
    profile: null,
  });

  assert.match(result.brief, /## Cosa devi consegnare/);
  assert.doesNotMatch(result.brief, /## Consegna finale attesa/);
  assert.match(result.brief, /## Come verrà verificato/);
});
