import { describe, expect, test } from 'vitest';

import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import { GlobalModelConfigSchema } from '../../src/workflows/modelConfigSchema.js';
import { durableSchemaShape } from '../../src/workflows/schemaFingerprint.js';

describe('workflow model configuration schema', () => {
  test('accepts the complete resolved production configuration at a durable boundary', () => {
    const {
      codexSceneIconModel: _codexSceneIconModel,
      codexPlaybackPreparationModel: _codexPlaybackPreparationModel,
      codexSceneModel: _codexSceneModel,
      embeddingModel: _embeddingModel,
      openAiSceneIconModel: _openAiSceneIconModel,
      openAiPlaybackPreparationModel: _openAiPlaybackPreparationModel,
      openAiSceneModel: _openAiSceneModel,
      sceneIconModel: _sceneIconModel,
      sceneIconReasoningEffort: _sceneIconReasoningEffort,
      playbackPreparationModel: _playbackPreparationModel,
      sceneModel: _sceneModel,
      playbackPreparationReasoningEffort: _playbackPreparationReasoningEffort,
      sceneReasoningEffort: _sceneReasoningEffort,
      ...durableConfig
    } = getGlobalModelConfig();
    // Scene and playback preparation settings are read live, so durable workflow config omits them.
    expect(GlobalModelConfigSchema.parse(getGlobalModelConfig())).toEqual(durableConfig);
    expect(() => durableSchemaShape(GlobalModelConfigSchema)).not.toThrow();
  });

  test('rejects unknown providers and unknown override slots', () => {
    const config = getGlobalModelConfig();
    expect(GlobalModelConfigSchema.safeParse({ ...config, aiProvider: 'unknown' }).success).toBe(
      false
    );
    expect(
      GlobalModelConfigSchema.safeParse({
        ...config,
        aiProviderOverrides: { ...config.aiProviderOverrides, unknown: 'codex' },
      }).success
    ).toBe(false);
  });
});
