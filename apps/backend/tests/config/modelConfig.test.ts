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
      artifactReasoningEffort: 'low',
      artifactModel: 'openrouter-artifact',
      artifactInteractiveModel: 'openrouter-interactive',
      artifactInteractiveReasoningEffort: 'minimal',
      assessmentReasoningEffort: 'low',
      codexArtifactModel: 'codex-artifact',
      codexArtifactInteractiveModel: 'codex-interactive',
      codexAssessmentModel: 'codex-assessment',
      openAiArtifactModel: 'openai-artifact',
      openAiArtifactInteractiveModel: 'openai-interactive',
      openAiAssessmentModel: 'openai-assessment',
      assessmentModel: 'openrouter-assessment',
    });

    expect(resolveTextModelConfig({ ...baseConfig, aiProvider: 'openrouter' }, 'artifact')).toEqual(
      {
        model: 'openrouter-artifact',
        reasoningEffort: 'low',
      }
    );
    expect(resolveTextModelConfig({ ...baseConfig, aiProvider: 'openai' }, 'artifact')).toEqual({
      model: 'openai-artifact',
      reasoningEffort: 'low',
    });
    expect(resolveTextModelConfig({ ...baseConfig, aiProvider: 'codex' }, 'artifact')).toEqual({
      model: 'codex-artifact',
      reasoningEffort: 'low',
    });

    expect(
      resolveTextModelConfig({ ...baseConfig, aiProvider: 'openrouter' }, 'artifactInteractive')
    ).toEqual({ model: 'openrouter-interactive', reasoningEffort: 'minimal' });
    expect(
      resolveTextModelConfig({ ...baseConfig, aiProvider: 'openai' }, 'artifactInteractive')
    ).toEqual({ model: 'openai-interactive', reasoningEffort: 'minimal' });
    expect(
      resolveTextModelConfig({ ...baseConfig, aiProvider: 'codex' }, 'artifactInteractive')
    ).toEqual({ model: 'codex-interactive', reasoningEffort: 'minimal' });

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
