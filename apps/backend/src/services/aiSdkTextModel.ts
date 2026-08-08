import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { JSONValue, LanguageModel, ToolSet } from 'ai';

import { requireOpenAiApiKey, requireOpenRouterApiKey } from '../config/chatConfig.js';
import {
  type AiProvider,
  type GlobalModelConfig,
  type ReasoningEffort,
  resolveAiProviderForSlot,
  resolveTextModelConfig,
  type TextModelSlot,
} from '../config/modelConfig.js';
import {
  isWorkflowAiMeteringActive,
  meterWorkflowLanguageModel,
} from '../workflows/workflowAiMetering.js';

interface ConfiguredTextModel {
  model: LanguageModel;
  modelName: string;
  providerOptions: Record<string, Record<string, JSONValue>>;
  tools?: ToolSet;
}

export interface ResolvedTextModelRequest {
  readonly model: string;
  readonly provider: Exclude<AiProvider, 'codex'>;
  readonly reasoningEffort: ReasoningEffort;
}

export const resolveOpenRouterProviderOptions = (
  reasoningEffort: ReasoningEffort
): Record<string, Record<string, JSONValue>> =>
  reasoningEffort === 'none'
    ? {}
    : {
        openrouter: { reasoning: { enabled: true, effort: reasoningEffort } },
      };

export const createConfiguredTextModelFromResolution = (
  resolved: ResolvedTextModelRequest,
  { webSearch = false }: { webSearch?: boolean } = {}
): ConfiguredTextModel => {
  if (resolved.provider === 'openai') {
    const openAi = createOpenAI({ apiKey: requireOpenAiApiKey() });
    const model = webSearch ? openAi.responses(resolved.model) : openAi.chat(resolved.model);
    return {
      model: meterWorkflowLanguageModel(model, {
        model: resolved.model,
        provider: resolved.provider,
      }),
      modelName: resolved.model,
      providerOptions: {
        openai: { reasoningEffort: resolved.reasoningEffort },
      },
      ...(webSearch
        ? {
            tools: { web_search: openAi.tools.webSearch({}) } as unknown as ToolSet,
          }
        : {}),
    };
  }

  const openRouter = createOpenRouter({ apiKey: requireOpenRouterApiKey() });
  const meterUsage = isWorkflowAiMeteringActive();
  const model =
    webSearch || meterUsage
      ? openRouter.chat(resolved.model, {
          ...(webSearch ? { web_search_options: {} } : {}),
          ...(meterUsage ? { usage: { include: true } } : {}),
        })
      : openRouter.chat(resolved.model);
  return {
    model: meterWorkflowLanguageModel(model, {
      model: resolved.model,
      provider: resolved.provider,
    }),
    modelName: resolved.model,
    providerOptions: resolveOpenRouterProviderOptions(resolved.reasoningEffort),
  };
};

export const createConfiguredTextModel = (
  config: GlobalModelConfig,
  slot: TextModelSlot,
  { model: modelOverride, webSearch = false }: { model?: string; webSearch?: boolean } = {}
): ConfiguredTextModel => {
  const provider = resolveAiProviderForSlot(config, slot);
  const resolved = resolveTextModelConfig(config, slot);
  if (provider === 'codex') {
    throw new Error('Codex app-server requires its dedicated streaming adapter.');
  }
  return createConfiguredTextModelFromResolution(
    {
      model: modelOverride || resolved.model,
      provider,
      reasoningEffort: resolved.reasoningEffort,
    },
    { webSearch }
  );
};
