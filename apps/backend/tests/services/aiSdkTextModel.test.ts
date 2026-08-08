import { describe, expect, test } from 'vitest';

import { resolveOpenRouterProviderOptions } from '../../src/services/aiSdkTextModel.js';

describe('OpenRouter reasoning options', () => {
  test('does not explicitly disable reasoning on endpoints that may require it', () => {
    expect(resolveOpenRouterProviderOptions('none')).toEqual({});
  });

  test('preserves an explicitly configured reasoning effort', () => {
    expect(resolveOpenRouterProviderOptions('medium')).toEqual({
      openrouter: { reasoning: { enabled: true, effort: 'medium' } },
    });
  });
});
