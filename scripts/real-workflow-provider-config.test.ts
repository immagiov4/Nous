import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  getGlobalModelConfig,
  patchGlobalModelConfig,
  resetModelConfigForTesting,
  resolveCodexServiceTierForSlot,
  resolveTextModelConfig,
  type TextModelSlot,
} from '../apps/backend/src/config/modelConfig.js';
import {
  configureWorkflowProviderModels,
  loadOpenRouterWorkflowCatalogue,
  OPENROUTER_WORKFLOW_MODELS,
  parseWorkflowProviderArgs,
  validateOpenRouterWorkflowModels,
} from './real-workflow-provider-config.js';

const originalConfig = getGlobalModelConfig();
beforeEach(() => {
  resetModelConfigForTesting();
  vi.stubEnv('SUPABASE_URL', '');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
});
afterEach(() => {
  resetModelConfigForTesting();
  patchGlobalModelConfig(originalConfig);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test('parses every provider and case with an explicit execution mode', () => {
  for (const provider of ['codex', 'openrouter']) {
    for (const scenarioCase of ['simple', 'realistic']) {
      for (const mode of ['--run', '--dry-run']) {
        expect(
          parseWorkflowProviderArgs(['--provider', provider, '--case', scenarioCase, mode])
        ).toEqual({ provider, case: scenarioCase, dryRun: mode === '--dry-run' });
      }
    }
  }
});

test('rejects incomplete, unsupported and conflicting selections before execution', () => {
  const selection = ['--provider', 'codex', '--case', 'simple'];
  for (const args of [
    [],
    selection,
    [...selection, '--run', '--dry-run'],
    ['--provider', 'openai', '--case', 'simple', '--run'],
    ['--provider', 'codex', '--case', 'unknown', '--run'],
    ['--provider', 'codex', '--run'],
    ['--case', 'simple', '--run'],
    [...selection, '--run', '--unknown'],
    [...selection, '--run', 'extra'],
  ]) {
    expect(() => parseWorkflowProviderArgs(args), JSON.stringify(args)).toThrow();
  }
});

test('uses app defaults on Codex and small OpenRouter models with the resolved efforts and tiers', async () => {
  const original = patchGlobalModelConfig({
    courseReasoningEffort: 'high',
    lessonReasoningEffort: 'medium',
    artifactReasoningEffort: 'none',
    artifactInteractiveReasoningEffort: 'minimal',
    researchReasoningEffort: 'high',
    codexFastModelSlots: ['course', 'artifact', 'scene'],
  });
  const codex = await configureWorkflowProviderModels('codex');
  const openrouter = await configureWorkflowProviderModels('openrouter');
  expect(codex.aiProvider).toBe('codex');
  expect(openrouter.aiProvider).toBe('openrouter');
  expect(openrouter.aiProviderOverrides).toEqual({});
  const slots: TextModelSlot[] = [
    'course',
    'lesson',
    'research',
    'artifact',
    'artifactInteractive',
    'scene',
    'sceneIcon',
    'assessment',
    'context',
    'progress',
    'playbackPreparation',
  ];
  for (const slot of slots) {
    expect(resolveTextModelConfig(codex, slot)).toEqual(
      resolveTextModelConfig({ ...original, aiProvider: 'codex', aiProviderOverrides: {} }, slot)
    );
    expect(resolveTextModelConfig(openrouter, slot).reasoningEffort).toBe(
      resolveTextModelConfig(original, slot).reasoningEffort
    );
    expect(resolveCodexServiceTierForSlot(codex, slot)).toBe(
      resolveCodexServiceTierForSlot(original, slot)
    );
    expect(resolveTextModelConfig(openrouter, slot).model).toBe(
      slot === 'scene' || slot === 'sceneIcon' || slot === 'playbackPreparation'
        ? OPENROUTER_WORKFLOW_MODELS.scene
        : OPENROUTER_WORKFLOW_MODELS.text
    );
  }
  expect(resolveTextModelConfig(codex, 'artifact').model).toBe(original.codexArtifactModel);
  expect(openrouter.ttsModel).toBe(original.ttsModel);
  expect(openrouter.imageModel).toBe(original.imageModel);
});

test('loads persisted models, efforts and service tiers like the app', async () => {
  vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key');
  const fetchConfig = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify([
        {
          course_reasoning_effort: 'high',
          lesson_reasoning_effort: 'minimal',
          artifact_reasoning_effort: 'medium',
          codex_fast_model_slots: ['lesson', 'sceneIcon'],
          codex_lesson_model: 'persisted-large-model',
        },
      ]),
      { status: 200 }
    )
  );
  vi.stubGlobal('fetch', fetchConfig);
  const config = await configureWorkflowProviderModels('codex');
  expect(fetchConfig).toHaveBeenCalledTimes(1);
  expect(resolveTextModelConfig(config, 'course')).toEqual({
    model: originalConfig.codexCourseModel,
    reasoningEffort: 'high',
  });
  expect(resolveTextModelConfig(config, 'lesson')).toEqual({
    model: 'persisted-large-model',
    reasoningEffort: 'minimal',
  });
  expect(resolveTextModelConfig(config, 'artifact').reasoningEffort).toBe('medium');
  expect(resolveCodexServiceTierForSlot(config, 'lesson')).toBe('fast');
  expect(resolveCodexServiceTierForSlot(config, 'course')).toBeUndefined();
});

test('validates the complete catalogue selection once in stable order', () => {
  expect(
    validateOpenRouterWorkflowModels(
      {
        scene: { model: OPENROUTER_WORKFLOW_MODELS.scene },
        lesson: { model: OPENROUTER_WORKFLOW_MODELS.text },
        course: { model: OPENROUTER_WORKFLOW_MODELS.text },
      },
      [{ id: 'unrelated' }, ...Object.values(OPENROUTER_WORKFLOW_MODELS).map(id => ({ id }))]
    )
  ).toEqual(
    Object.values(OPENROUTER_WORKFLOW_MODELS).sort((left, right) => left.localeCompare(right))
  );
});

test('blocks missing models even when another selected model is available', () => {
  const models = [OPENROUTER_WORKFLOW_MODELS.text, OPENROUTER_WORKFLOW_MODELS.scene];
  const slots = { lesson: { model: models[0] }, scene: { model: models[1] } };
  expect(() => validateOpenRouterWorkflowModels(slots, [{ id: models[0] }])).toThrow(
    `OpenRouter catalogue is missing workflow models: ${models[1]}. Paid calls are blocked.`
  );
  expect(() => validateOpenRouterWorkflowModels(slots, [])).toThrow(
    `OpenRouter catalogue is missing workflow models: ${models.join(', ')}.`
  );
});

test('blocks a missing speech model before a cell can start and ignores unused images', async () => {
  patchGlobalModelConfig({ ttsModel: 'removed-speech-model', imageModel: 'unused-image-model' });
  const config = await configureWorkflowProviderModels('openrouter');
  const slots = {
    lesson: resolveTextModelConfig(config, 'lesson'),
    scene: resolveTextModelConfig(config, 'scene'),
    tts: { model: config.ttsModel },
    image: { model: config.imageModel },
  };
  const catalogue = Object.values(OPENROUTER_WORKFLOW_MODELS).map(id => ({ id }));
  expect(() => validateOpenRouterWorkflowModels(slots, catalogue)).toThrow(
    'OpenRouter catalogue is missing workflow models: removed-speech-model. Paid calls are blocked.'
  );
  expect(validateOpenRouterWorkflowModels(slots, [...catalogue, { id: config.ttsModel }])).toEqual(
    [...Object.values(OPENROUTER_WORKFLOW_MODELS), config.ttsModel].sort((left, right) =>
      left.localeCompare(right)
    )
  );
});

test('discovers speech as well as text without requiring token-pricing fields', async () => {
  const text = { id: OPENROUTER_WORKFLOW_MODELS.text };
  const speech = { id: 'speech-model', pricing: { input_character: '0.0001' } };
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify({
            data:
              new URL(url).searchParams.get('output_modalities') === 'all'
                ? [text, speech]
                : [text],
          })
        )
    )
  );
  expect(
    validateOpenRouterWorkflowModels(
      { lesson: { model: text.id }, tts: { model: speech.id } },
      await loadOpenRouterWorkflowCatalogue()
    )
  ).toEqual([text.id, speech.id]);
});
