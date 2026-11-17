import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type { ApplicationExerciseNode } from '../../../types.ts';
import { buildTestLearningPlan, buildTestLesson } from '../../helpers/learningPlan.ts';
import { buildLegacySourceFixture } from '../../helpers/legacySourceIndex.ts';

const callOpenRouter = vi.fn();
vi.mock('../../../services/openrouter/shared.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../services/openrouter/shared.ts')>()),
  callOpenRouter,
}));
const { generateApplicationExerciseBrief } = await import(
  '../../../services/openrouter/exercises/brief.ts'
);

test('exercise brief request projects legacy chunks before inserting source headings', async () => {
  const { documentIndex } = buildLegacySourceFixture(`𝑋${'a'.repeat(7_997)}𝑋${'z'.repeat(7_999)}`);
  const before = JSON.stringify(documentIndex);
  const exercise: ApplicationExerciseNode = {
    kind: 'exercise',
    id: 'exercise-1',
    title: 'Apply',
    description: 'Apply the source.',
    assessedObjective: 'Use evidence',
    attachments: [],
    currentFeedback: null,
    isCompleted: false,
    feedbackStale: false,
    updatedAt: '2026-11-01T00:00:00Z',
  };
  const lesson = buildTestLesson({
    content: 'Completed lesson.',
    primaryChunkIds: documentIndex.chunks.map(chunk => chunk.id),
  });
  const learningPlan = buildTestLearningPlan([lesson]);
  learningPlan.modules[0].children.push(exercise);
  callOpenRouter.mockResolvedValue(JSON.stringify({ briefMarkdown: 'Apply the evidence.' }));
  const result = await generateApplicationExerciseBrief({
    documentIndex,
    exercise,
    learningPlan,
    profile: null,
  });
  const prompt = callOpenRouter.mock.calls[0][0].messages[1].content;
  assert.match(prompt, /FONTI DEL SEGMENTO/u);
  assert.match(prompt, /𝑋/u);
  assert.doesNotMatch(prompt, /[\uD800-\uDFFF]/u);
  assert.equal(result.brief, 'Apply the evidence.');
  assert.equal(JSON.stringify(documentIndex), before);
});
