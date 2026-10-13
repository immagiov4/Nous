import { parseArgs } from 'node:util';
import {
  getResolvedGlobalModelConfig,
  patchGlobalModelConfig,
} from '../apps/backend/src/config/modelConfig.js';

export type WorkflowProvider = 'codex' | 'openrouter';
export type WorkflowCase = 'simple' | 'realistic';

export const parseWorkflowProviderArgs = (args: string[]) => {
  const { values } = parseArgs({
    args,
    options: {
      provider: { type: 'string' },
      case: { type: 'string' },
      'dry-run': { type: 'boolean' },
      run: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  if (values.provider !== 'codex' && values.provider !== 'openrouter') {
    throw new Error('Choose --provider codex|openrouter explicitly.');
  }
  if (values.case !== 'simple' && values.case !== 'realistic') {
    throw new Error('Choose --case simple|realistic explicitly.');
  }
  if (Boolean(values.run) === Boolean(values['dry-run'])) {
    throw new Error('Choose exactly one of --run or --dry-run.');
  }
  return { provider: values.provider, case: values.case, dryRun: Boolean(values['dry-run']) };
};

/** Validates the whole selection before the harness may make a paid request. */
export const validateOpenRouterWorkflowModels = (
  models: readonly string[],
  catalogue: readonly { id: string }[]
): string[] => {
  const available = new Set(catalogue.map(model => model.id));
  const requested = [...new Set(models)].sort((left, right) => left.localeCompare(right));
  const missing = requested.filter(model => !available.has(model));
  if (missing.length) {
    throw new Error(
      `OpenRouter catalogue is missing workflow models: ${missing.join(', ')}. Paid calls are blocked.`
    );
  }
  return requested;
};

export const configureWorkflowProviderModels = async (provider: WorkflowProvider) => {
  const original = await getResolvedGlobalModelConfig();
  const codex = patchGlobalModelConfig({
    ...original,
    aiProvider: 'codex',
    aiProviderOverrides: {},
  });
  if (provider === 'codex') return codex;
  return patchGlobalModelConfig({
    aiProvider: provider,
    courseModel: 'openai/gpt-5.6-luna',
    lessonModel: 'openai/gpt-5.6-luna',
    researchModel: 'openai/gpt-5.6-luna',
    artifactModel: 'openai/gpt-5.6-luna',
    artifactInteractiveModel: 'openai/gpt-5.6-luna',
    sceneModel: 'openai/gpt-6-luna',
    sceneIconModel: 'openai/gpt-6-luna',
    assessmentModel: 'openai/gpt-5.6-luna',
    contextModel: 'openai/gpt-5.6-luna',
    progressModel: 'openai/gpt-5.6-luna',
    playbackPreparationModel: 'openai/gpt-6-luna',
  });
};
