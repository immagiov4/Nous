import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { buildCourseSourceDescriptors } from '../../../services/projects/courseSources.ts';
import { encodeTextBase64 } from '../../../services/projects/projectSource.ts';
import type { FileData } from '../../../types.ts';
import { flattenLessons } from '../../../utils/learning/pathNodes.ts';

const callOpenRouterMock = vi.fn();
const retryWithBackoffMock = vi.fn(async <T>(operation: () => Promise<T>) => await operation());

vi.mock('../../../services/openrouter/shared.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../services/openrouter/shared.ts')>();
  return {
    ...actual,
    MODEL_REASONING: 'reasoning-model',
    callOpenRouter: callOpenRouterMock,
    retryWithBackoff: retryWithBackoffMock,
  };
});

const { generateLearningPlan, generateLearningPlanFromSourceSet } = await import(
  '../../../services/openrouter/planning/index.ts'
);

beforeEach(() => {
  callOpenRouterMock.mockReset();
  retryWithBackoffMock.mockClear();
});

test('generateLearningPlan uses medium effort for both first draft and refinement', async () => {
  callOpenRouterMock
    .mockResolvedValueOnce(
      JSON.stringify({
        title: 'Percorso breve',
        summary: 'Sintesi',
        sections: [
          {
            id: 'section-1',
            moduleTitle: 'Modulo 1',
            title: 'Concetto chiave',
            description: 'Spiega il concetto chiave del testo.',
            type: 'core',
            isCompleted: false,
          },
        ],
      })
    )
    .mockResolvedValueOnce(
      JSON.stringify({
        title: 'Percorso breve',
        summary: 'Sintesi',
        sections: [
          {
            id: 'section-1',
            moduleTitle: 'Modulo 1',
            title: 'Concetto chiave',
            description: 'Spiega il concetto chiave del testo.',
            type: 'core',
            isCompleted: false,
          },
        ],
      })
    );

  const file: FileData = {
    name: 'paper.txt',
    mimeType: 'text/plain',
    data: encodeTextBase64('Breve paper scientifico con un solo concetto davvero centrale.'),
  };

  const plan = await generateLearningPlan(file, []);

  assert.equal(flattenLessons(plan.modules).length, 1);
  assert.equal(callOpenRouterMock.mock.calls.length, 2);
  assert.deepEqual(callOpenRouterMock.mock.calls[0]?.[0]?.reasoning, {
    effort: 'medium',
    exclude: false,
  });
  assert.deepEqual(callOpenRouterMock.mock.calls[1]?.[0]?.reasoning, {
    effort: 'medium',
    exclude: false,
  });
});

test('generateLearningPlanFromSourceSet plans across every source and deduplicates overlapping lessons', async () => {
  callOpenRouterMock.mockResolvedValue(
    JSON.stringify({
      title: 'Percorso multifonte',
      summary: 'Sintesi integrata',
      sections: [
        {
          moduleTitle: 'Fondamenti',
          title: 'Effetto fotoelettrico',
          description: 'Spiega emissione elettronica, soglia di frequenza ed energia del fotone.',
          type: 'core',
        },
        {
          moduleTitle: 'Fondamenti',
          title: 'Effetto fotoelettrico',
          description: 'Spiega emissione elettronica, soglia di frequenza ed energia del fotone.',
          type: 'core',
        },
      ],
    })
  );
  const sources = buildCourseSourceDescriptors([
    {
      name: 'teoria.md',
      mimeType: 'text/markdown',
      data: encodeTextBase64('# Teoria\nEnergia dei fotoni e soglia di frequenza.'),
    },
    {
      name: 'esperimenti.txt',
      mimeType: 'text/plain',
      data: encodeTextBase64('Misure sperimentali dell emissione elettronica.'),
    },
  ]);

  const plan = await generateLearningPlanFromSourceSet(sources, []);
  const requestContent = String(callOpenRouterMock.mock.calls[0]?.[0]?.messages[1]?.content || '');

  assert.equal(callOpenRouterMock.mock.calls.length, 1);
  assert.equal(flattenLessons(plan.modules).length, 1);
  assert.ok(sources.every(source => requestContent.includes(source.id)));
  assert.deepEqual(callOpenRouterMock.mock.calls[0]?.[0]?.reasoning, {
    effort: 'medium',
    exclude: false,
  });
});
