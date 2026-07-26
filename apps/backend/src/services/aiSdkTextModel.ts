import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { JSONValue, LanguageModel, ToolSet } from 'ai';

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
  tools?: ToolSet;
}

export const createConfiguredTextModel = (
  config: GlobalModelConfig,
  slot: TextModelSlot,
  { webSearch = false }: { webSearch?: boolean } = {}
): ConfiguredTextModel => {
  const provider = resolveAiProviderForSlot(config, slot);
  if (provider === 'codex') {
    throw new Error('Codex app-server requires its dedicated streaming adapter.');
  }

  const { model: modelName, reasoningEffort } = resolveTextModelConfig(config, slot);

  if (provider === 'openai') {
    const openAi = createOpenAI({ apiKey: requireOpenAiApiKey() });
    return {
      model: webSearch ? openAi.responses(modelName) : openAi.chat(modelName),
      modelName,
      providerOptions: {
        openai: { reasoningEffort },
      },
      ...(webSearch
        ? {
            tools: { web_search: openAi.tools.webSearch({}) } as unknown as ToolSet,
          }
        : {}),
    };
  }

  const openRouter = createOpenRouter({ apiKey: requireOpenRouterApiKey() });
  return {
    model: webSearch
      ? openRouter.chat(modelName, { web_search_options: {} })
      : openRouter.chat(modelName),
    modelName,
    providerOptions: {
      openrouter: { reasoning: { enabled: true, effort: reasoningEffort } },
    },
  };
};
