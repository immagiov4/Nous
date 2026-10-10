import { beforeEach, describe, expect, test } from 'vitest';

import {
  getGlobalModelConfig,
  getResolvedModelConfigForProvider,
  isTextModelSlot,
  patchGlobalModelConfig,
  resetModelConfigForTesting,
  resolveAiProviderForSlot,
  resolveCodexServiceTierForSlot,
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
      codexCourseModel: 'codex-course',
      codexArtifactModel: 'codex-artifact',
      codexArtifactInteractiveModel: 'codex-interactive',
      codexAssessmentModel: 'codex-assessment',
      openAiArtifactModel: 'openai-artifact',
      openAiArtifactInteractiveModel: 'openai-interactive',
      openAiAssessmentModel: 'openai-assessment',
      openAiCourseModel: 'openai-course',
      assessmentModel: 'openrouter-assessment',
      courseModel: 'openrouter-course',
      courseReasoningEffort: 'high',
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

    expect(resolveTextModelConfig({ ...baseConfig, aiProvider: 'openrouter' }, 'course')).toEqual({
      model: 'openrouter-course',
      reasoningEffort: 'high',
    });
    expect(resolveTextModelConfig({ ...baseConfig, aiProvider: 'openai' }, 'course')).toEqual({
      model: 'openai-course',
      reasoningEffort: 'high',
    });
    expect(resolveTextModelConfig({ ...baseConfig, aiProvider: 'codex' }, 'course')).toEqual({
      model: 'codex-course',
      reasoningEffort: 'high',
    });
  });

  test('applies a request provider without mutating the admin default', async () => {
    patchGlobalModelConfig({ aiProvider: 'openrouter' });

    const requestConfig = await getResolvedModelConfigForProvider('codex');

    expect(requestConfig.aiProvider).toBe('codex');
    expect(getGlobalModelConfig().aiProvider).toBe('openrouter');
  });

  test('defaults OpenAI research to its Chat Completions search model', () => {
    expect(getGlobalModelConfig().openAiResearchModel).toBe('gpt-5-search-api');
  });

  test('uses the configured research reasoning effort', () => {
    const config = patchGlobalModelConfig({ researchReasoningEffort: 'high' });

    expect(resolveTextModelConfig(config, 'research').reasoningEffort).toBe('high');
  });

  test('keeps resumable workflows without a research effort compatible', () => {
    const { researchReasoningEffort: _researchReasoningEffort, ...previousConfig } =
      getGlobalModelConfig();

    expect(
      resolveTextModelConfig(previousConfig as ReturnType<typeof getGlobalModelConfig>, 'research')
    ).toMatchObject({ reasoningEffort: 'none' });
  });

  test('resolves the Codex service tier from the configured model slots', () => {
    const config = patchGlobalModelConfig({ codexFastModelSlots: ['course', 'lesson'] });

    expect(resolveCodexServiceTierForSlot(config, 'lesson')).toBe('fast');
    expect(resolveCodexServiceTierForSlot(config, 'course')).toBe('fast');
    expect(resolveCodexServiceTierForSlot(config, 'research')).toBeUndefined();
  });

  test.each([
    'openrouter',
    'openai',
    'codex',
  ] as const)('defaults playback preparation independently of lessons for %s', aiProvider => {
    const config = patchGlobalModelConfig({ aiProvider, lessonModel: 'custom-lesson' });

    expect(isTextModelSlot('playbackPreparation')).toBe(true);
    expect(resolveTextModelConfig(config, 'playbackPreparation')).toEqual({
      model: aiProvider === 'openrouter' ? 'openai/gpt-6-luna' : 'gpt-6-luna',
      reasoningEffort: 'low',
    });
  });

  test.each([
    'openrouter',
    'openai',
    'codex',
  ] as const)('resolves the configured playback preparation model for %s', aiProvider => {
    const config = patchGlobalModelConfig({
      aiProvider,
      playbackPreparationModel: 'openrouter-playback',
      codexPlaybackPreparationModel: 'codex-playback',
      openAiPlaybackPreparationModel: 'openai-playback',
      playbackPreparationReasoningEffort: 'medium',
    });

    expect(resolveTextModelConfig(config, 'playbackPreparation')).toEqual({
      model: `${aiProvider}-playback`,
      reasoningEffort: 'medium',
    });
  });

  test('keeps playback preparation fast and outside durable slot settings', async () => {
    const config = patchGlobalModelConfig({
      aiProvider: 'codex',
      aiProviderOverrides: { playbackPreparation: 'openai', lesson: 'openrouter' },
      codexFastModelSlots: ['playbackPreparation', 'lesson'],
    });

    expect(config.aiProviderOverrides).toEqual({ lesson: 'openrouter' });
    expect(config.codexFastModelSlots).toEqual(['lesson']);
    expect(resolveAiProviderForSlot(config, 'playbackPreparation')).toBe('codex');
    expect(resolveCodexServiceTierForSlot(config, 'playbackPreparation')).toBe('fast');
    expect(
      resolveCodexServiceTierForSlot({ ...config, codexFastModelSlots: [] }, 'playbackPreparation')
    ).toBe('fast');
    const userConfig = await getResolvedModelConfigForProvider('openrouter', {
      playbackPreparation: 'openai',
    });
    expect(resolveAiProviderForSlot(userConfig, 'playbackPreparation')).toBe('openrouter');
  });

  test('resolves global and user provider overrides by model slot', async () => {
    patchGlobalModelConfig({
      aiProvider: 'openrouter',
      aiProviderOverrides: { course: 'openrouter', lesson: 'codex', research: 'openai' },
    });

    const globalConfig = await getResolvedModelConfigForProvider(undefined);
    expect(resolveAiProviderForSlot(globalConfig, 'lesson')).toBe('codex');
    expect(resolveAiProviderForSlot(globalConfig, 'course')).toBe('openrouter');
    expect(resolveAiProviderForSlot(globalConfig, 'assessment')).toBe('openrouter');

    const userConfig = await getResolvedModelConfigForProvider('codex', {
      context: 'openrouter',
    });
    expect(resolveAiProviderForSlot(userConfig, 'lesson')).toBe('codex');
    expect(resolveAiProviderForSlot(userConfig, 'context')).toBe('openrouter');
    expect(resolveAiProviderForSlot(userConfig, 'research')).toBe('codex');
  });
});
