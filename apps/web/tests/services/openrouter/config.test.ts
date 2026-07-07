import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { resolveOpenRouterModel } from '../../../services/openrouter/config.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

test('resolveOpenRouterModel ignores legacy UI model preferences', () => {
  vi.stubGlobal('window', {
    localStorage: {
      getItem: () =>
        JSON.stringify({
          preferredLessonModel: 'openai/gpt-5.4-mini',
          preferredContextModel: 'openai/gpt-5.4-nano',
          preferredAssessmentModel: 'mistralai/mistral-small-2603',
        }),
    },
  });

  assert.equal(
    resolveOpenRouterModel('nvidia/nemotron-nano-12b-v2-vl', 'lesson'),
    'nvidia/nemotron-nano-12b-v2-vl'
  );
  assert.equal(
    resolveOpenRouterModel('nvidia/nemotron-nano-12b-v2-vl', 'lesson', false),
    'nvidia/nemotron-nano-12b-v2-vl'
  );
  assert.equal(
    resolveOpenRouterModel('mistralai/mistral-small-2603', 'assessment'),
    'mistralai/mistral-small-2603'
  );
});
