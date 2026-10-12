import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.hoisted(() => {
  for (const name of ['MODEL_PLAYBACK_PREPARATION', 'CODEX_MODEL_PLAYBACK_PREPARATION']) {
    vi.stubEnv(name, '');
  }
});
afterAll(() => vi.unstubAllEnvs());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

import {
  getGlobalModelConfig,
  getResolvedModelConfigForProvider,
  isAiProvider,
  isTextModelSlot,
  loadPersistedGlobalModelConfig,
  patchGlobalModelConfig,
  readModelProviderOverrides,
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
    expect(resolveTextModelConfig({ ...baseConfig, aiProvider: 'codex' }, 'artifact')).toEqual({
      model: 'codex-artifact',
      reasoningEffort: 'low',
    });

    expect(
      resolveTextModelConfig({ ...baseConfig, aiProvider: 'openrouter' }, 'artifactInteractive')
    ).toEqual({ model: 'openrouter-interactive', reasoningEffort: 'minimal' });
    expect(
      resolveTextModelConfig({ ...baseConfig, aiProvider: 'codex' }, 'artifactInteractive')
    ).toEqual({ model: 'codex-interactive', reasoningEffort: 'minimal' });

    expect(
      resolveTextModelConfig({ ...baseConfig, aiProvider: 'openrouter' }, 'assessment')
    ).toEqual({ model: 'openrouter-assessment', reasoningEffort: 'low' });
    expect(resolveTextModelConfig({ ...baseConfig, aiProvider: 'codex' }, 'assessment')).toEqual({
      model: 'codex-assessment',
      reasoningEffort: 'low',
    });

    expect(resolveTextModelConfig({ ...baseConfig, aiProvider: 'openrouter' }, 'course')).toEqual({
      model: 'openrouter-course',
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

  test('rejects the removed provider and keeps the current provider on invalid requests', async () => {
    patchGlobalModelConfig({ aiProvider: 'codex' });
    expect(isAiProvider('codex')).toBe(true);
    expect(isAiProvider('openrouter')).toBe(true);
    expect(isAiProvider('openai')).toBe(false);
    expect((await getResolvedModelConfigForProvider('openai')).aiProvider).toBe('codex');
    expect(readModelProviderOverrides({ lesson: 'openai', course: 'openrouter' })).toEqual({
      course: 'openrouter',
    });
  });

  test('keeps the active provider when a persisted row selects the removed provider', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key');
    patchGlobalModelConfig({ aiProvider: 'codex' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            {
              ai_provider: 'openai',
              ai_provider_overrides: { lesson: 'openai', course: 'openrouter' },
            },
          ]),
          { status: 200 }
        )
      )
    );
    const config = await loadPersistedGlobalModelConfig();
    expect(config.aiProvider).toBe('codex');
    expect(config.aiProviderOverrides).toEqual({ course: 'openrouter' });
  });

  test('uses the existing environment default for the removed provider', async () => {
    vi.stubEnv('AI_PROVIDER', 'openai');
    vi.resetModules();
    const freshConfig = await import('../../src/config/modelConfig.js');
    expect(freshConfig.getGlobalModelConfig().aiProvider).toBe('openrouter');
    vi.resetModules();
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
    'codex',
  ] as const)('defaults playback preparation independently of lessons for %s', aiProvider => {
    const config = patchGlobalModelConfig({ aiProvider, lessonModel: 'custom-lesson' });

    expect(isTextModelSlot('playbackPreparation')).toBe(true);
    expect(resolveTextModelConfig(config, 'playbackPreparation')).toEqual({
      model: aiProvider === 'openrouter' ? 'anthropic/claude-haiku-5.5' : 'gpt-6-luna',
      reasoningEffort: 'low',
    });
  });

  test.each([
    'openrouter',
    'codex',
  ] as const)('resolves the configured playback preparation model for %s', aiProvider => {
    const config = patchGlobalModelConfig({
      aiProvider,
      playbackPreparationModel: 'openrouter-playback',
      codexPlaybackPreparationModel: 'codex-playback',
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
      aiProviderOverrides: { playbackPreparation: 'openrouter', lesson: 'openrouter' },
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
      playbackPreparation: 'openrouter',
    });
    expect(resolveAiProviderForSlot(userConfig, 'playbackPreparation')).toBe('openrouter');
  });

  test('resolves global and user provider overrides by model slot', async () => {
    patchGlobalModelConfig({
      aiProvider: 'openrouter',
      aiProviderOverrides: { course: 'openrouter', lesson: 'codex', research: 'openrouter' },
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
