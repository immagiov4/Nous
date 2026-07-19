import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { JSONValue, LanguageModel } from 'ai';

import { requireOpenAiApiKey, requireOpenRouterApiKey } from '../config/chatConfig.js';
import {
  type GlobalModelConfig,
  resolveAiProviderForSlot,
  resolveTextModelConfig,
  type TextModelSlot,
} from '../config/modelConfig.js';

interface ConfiguredTextModel {
  model: LanguageModel;
  modelName: string;
  providerOptions: Record<string, Record<string, JSONValue>>;
}

export const createConfiguredTextModel = (
  config: GlobalModelConfig,
  slot: TextModelSlot
): ConfiguredTextModel => {
  const provider = resolveAiProviderForSlot(config, slot);
  if (provider === 'codex') {
    throw new Error('Codex app-server requires its dedicated streaming adapter.');
  }

  const { model: modelName, reasoningEffort } = resolveTextModelConfig(config, slot);

  if (provider === 'openai') {
    const openAi = createOpenAI({ apiKey: requireOpenAiApiKey() });
    return {
      model: openAi.chat(modelName),
      modelName,
      providerOptions: {
        openai: { reasoningEffort },
      },
    };
  }

  const openRouter = createOpenRouter({ apiKey: requireOpenRouterApiKey() });
  return {
    model: openRouter.chat(modelName),
    modelName,
    providerOptions: {
      openrouter: { reasoning: { enabled: true, effort: reasoningEffort } },
    },
  };
};
