import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { resolveOpenRouterModel } from '../../../services/openrouter/config.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

test('resolveOpenRouterModel can bypass UI model preferences for fixed internal tasks', () => {
  vi.stubGlobal('window', {
    localStorage: {
      getItem: () =>
        JSON.stringify({
          preferredLessonModel: 'openai/gpt-5.4-mini',
          preferredContextModel: 'openai/gpt-5.4-nano',
        }),
    },
  });

  assert.equal(
    resolveOpenRouterModel('nvidia/nemotron-nano-12b-v2-vl', 'lesson'),
    'openai/gpt-5.4-mini'
  );
  assert.equal(
    resolveOpenRouterModel('nvidia/nemotron-nano-12b-v2-vl', 'lesson', false),
    'nvidia/nemotron-nano-12b-v2-vl'
  );
});
