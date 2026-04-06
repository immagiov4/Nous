import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { FileData } from '../../../types.ts';
import { encodeTextBase64 } from '../../../services/projects/projectSource.ts';

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

const { generateLearningPlan } = await import('../../../services/openrouter/planning.ts');

beforeEach(() => {
  callOpenRouterMock.mockReset();
  retryWithBackoffMock.mockClear();
});

test('generateLearningPlan uses high effort for both first draft and refinement', async () => {
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

  assert.equal(plan.sections.length, 1);
  assert.equal(callOpenRouterMock.mock.calls.length, 2);
  assert.deepEqual(callOpenRouterMock.mock.calls[0]?.[0]?.reasoning, {
    effort: 'high',
    exclude: true,
  });
  assert.deepEqual(callOpenRouterMock.mock.calls[1]?.[0]?.reasoning, {
    effort: 'high',
    exclude: true,
  });
});