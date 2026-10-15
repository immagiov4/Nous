import { parseArgs } from 'node:util';
import * as z from 'zod';
import {
  type GlobalModelConfig,
  getResolvedGlobalModelConfig,
  patchGlobalModelConfig,
} from '../apps/backend/src/config/modelConfig.js';

export type WorkflowProvider = 'codex' | 'openrouter';
export type WorkflowCase = 'simple' | 'realistic';

export const OPENROUTER_WORKFLOW_MODELS = {
  text: 'openai/gpt-5.6-luna',
  scene: 'openai/gpt-6-luna',
} as const;

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

export const loadOpenRouterWorkflowCatalogue = async (): Promise<{ id: string }[]> => {
  const response = await fetch('https://openrouter.ai/api/v1/models?output_modalities=all');
  if (!response.ok) throw new Error('OpenRouter workflow catalogue unavailable.');
  return z.object({ data: z.array(z.object({ id: z.string() })) }).parse(await response.json())
    .data;
};

/** Validates the whole selection before the harness may make a paid request. */
export const validateOpenRouterWorkflowModels = (
  slots: Readonly<Record<string, { model: string }>>,
  catalogue: readonly { id: string }[]
): string[] => {
  const available = new Set(catalogue.map(model => model.id));
  const models = Object.entries(slots)
    .filter(([name]) => name !== 'image')
    .map(([, slot]) => slot.model);
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
  return patchGlobalModelConfig(selectOpenRouterWorkflowModels(original));
};

/** Select small workflow models without changing live application settings. */
export const selectOpenRouterWorkflowModels = (original: GlobalModelConfig): GlobalModelConfig => ({
  ...original,
  aiProvider: 'openrouter',
  aiProviderOverrides: {},
  courseModel: OPENROUTER_WORKFLOW_MODELS.text,
  lessonModel: OPENROUTER_WORKFLOW_MODELS.text,
  researchModel: OPENROUTER_WORKFLOW_MODELS.text,
  artifactModel: OPENROUTER_WORKFLOW_MODELS.text,
  artifactInteractiveModel: OPENROUTER_WORKFLOW_MODELS.text,
  sceneModel: OPENROUTER_WORKFLOW_MODELS.scene,
  sceneIconModel: OPENROUTER_WORKFLOW_MODELS.scene,
  assessmentModel: OPENROUTER_WORKFLOW_MODELS.text,
  contextModel: OPENROUTER_WORKFLOW_MODELS.text,
  progressModel: OPENROUTER_WORKFLOW_MODELS.text,
  playbackPreparationModel: OPENROUTER_WORKFLOW_MODELS.scene,
});
