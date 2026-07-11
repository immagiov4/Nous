import { beforeEach, describe, expect, test } from 'vitest';

import {
  getGlobalModelConfig,
  getResolvedModelConfigForProvider,
  patchGlobalModelConfig,
  resetModelConfigForTesting,
  resolveTextModelConfig,
} from '../../src/config/modelConfig.js';

describe('global AI provider model mapping', () => {
  beforeEach(() => {
    resetModelConfigForTesting();
  });

  test('maps each provider to its own admin model while sharing workload reasoning', () => {
    const baseConfig = patchGlobalModelConfig({
      assessmentReasoningEffort: 'low',
      codexAssessmentModel: 'codex-assessment',
      openAiAssessmentModel: 'openai-assessment',
      assessmentModel: 'openrouter-assessment',
    });

    expect(
      resolveTextModelConfig({ ...baseConfig, aiProvider: 'openrouter' }, 'assessment')
    ).toEqual({ model: 'openrouter-assessment', reasoningEffort: 'low' });
    expect(resolveTextModelConfig({ ...baseConfig, aiProvider: 'openai' }, 'assessment')).toEqual({
      model: 'openai-assessment',
      reasoningEffort: 'low',
    });
    expect(resolveTextModelConfig({ ...baseConfig, aiProvider: 'codex' }, 'assessment')).toEqual({
      model: 'codex-assessment',
      reasoningEffort: 'low',
    });
  });

  test('applies a request provider without mutating the admin default', async () => {
    patchGlobalModelConfig({ aiProvider: 'openrouter' });

    const requestConfig = await getResolvedModelConfigForProvider('codex');

    expect(requestConfig.aiProvider).toBe('codex');
    expect(getGlobalModelConfig().aiProvider).toBe('openrouter');
  });
});
