import { describe, expect, test } from 'vitest';

import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import {
  LessonVisualModelConfigSchema,
  resolveLessonVisualModelConfig,
} from '../../src/services/lessonVisualModelConfig.js';

describe('lesson visual model configuration', () => {
  test('freezes only the resolved providers, models and review policy used by visual generation', () => {
    const resolved = resolveLessonVisualModelConfig({
      ...getGlobalModelConfig(),
      aiProvider: 'openrouter',
      aiProviderOverrides: {
        artifact: 'openrouter',
        artifactInteractive: 'codex',
        image: 'openrouter',
      },
      artifactReasoningEffort: 'low',
      artifactVisualReviewEnabled: true,
      artifactVisualReviewMaxRounds: 2,
      codexArtifactInteractiveModel: 'codex-interactive',
      codexFastModelSlots: ['artifactInteractive'],
      imageModel: 'openrouter-image',
      artifactModel: 'openrouter-artifact',
    });

    expect(LessonVisualModelConfigSchema.parse(resolved)).toEqual({
      artifact: {
        model: 'openrouter-artifact',
        provider: 'openrouter',
        reasoningEffort: 'low',
      },
      artifactInteractive: {
        model: 'codex-interactive',
        provider: 'codex',
        reasoningEffort: getGlobalModelConfig().artifactInteractiveReasoningEffort,
        serviceTier: 'fast',
      },
      image: {
        model: 'openrouter-image',
        provider: 'openrouter',
      },
      review: {
        enabled: true,
        maxRounds: 2,
      },
    });
    expect(resolved).not.toHaveProperty('ttsModel');
    expect(resolved).not.toHaveProperty('updatedAt');
  });

  test('does not assign a fast service tier to non-Codex providers', () => {
    const resolved = resolveLessonVisualModelConfig({
      ...getGlobalModelConfig(),
      aiProvider: 'openrouter',
      aiProviderOverrides: {},
      codexFastModelSlots: ['artifact', 'artifactInteractive'],
    });

    expect(resolved.artifact).not.toHaveProperty('serviceTier');
    expect(resolved.artifactInteractive).not.toHaveProperty('serviceTier');
  });
});
