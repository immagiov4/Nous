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

test('application exercise prompt requires a self-contained source artifact and concise delivery', async () => {
  callOpenRouterMock.mockResolvedValue(
    JSON.stringify({
      briefMarkdown:
        '## Materiale fornito\n\nMessaggio di esempio.\n\n## Consegna\n\nScrivi una diagnosi.',
    })
  );

  await generateApplicationExerciseBrief({
    exercise,
    learningPlan: buildPlanWithExercise(),
    profile: null,
  });

  const prompt = callOpenRouterMock.mock.calls[0]?.[0]?.messages?.[1]?.content;
  assert.equal(typeof prompt, 'string');
  assert.match(prompt, /fornisci tu nella traccia tutto il materiale/i);
  assert.match(prompt, /non chiedere allo studente di cercare, scegliere o recuperare/i);
  assert.match(prompt, /una sola sezione dedicata alla consegna/i);
  assert.match(prompt, /non ripetere la consegna in una conclusione finale/i);
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
