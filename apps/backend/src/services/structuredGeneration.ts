import { generateText, jsonSchema, Output } from 'ai';

import {
  type GlobalModelConfig,
  type ReasoningEffort,
  resolveAiProviderForSlot,
  resolveCodexServiceTierForSlot,
  resolveTextModelConfig,
  type TextModelSlot,
} from '../config/modelConfig.js';
import { createConfiguredTextModel } from './aiSdkTextModel.js';
import { runCodexAppServerTurn } from './codexAppServer.js';

/** JSON Schema of a structured model response, named for providers that require it. */
export interface StructuredOutputSchema {
  readonly name: string;
  readonly schema: Record<string, unknown>;
}

export interface StructuredGenerationRequest {
  readonly config: GlobalModelConfig;
  readonly output: StructuredOutputSchema;
  readonly prompt: string;
  /** Overrides the slot's configured reasoning effort. */
  readonly reasoningEffort?: ReasoningEffort;
  readonly signal: AbortSignal;
  readonly slot: TextModelSlot;
  readonly system: string;
  /** Lets the model search the web; local tools and files stay forbidden. */
  readonly webSearch?: boolean;
}

// The Codex app-server runs an agent with tools and a workspace; structured
// generation needs a single schema-bound answer, so the turn forbids local
// access and every tool except an explicitly requested web search.
const CODEX_TOOL_FREE_INSTRUCTION = 'Do not use tools or access local files.';
const CODEX_WEB_ONLY_INSTRUCTION = 'Do not access local files.';

/**
 * Generates one schema-bound response with the provider configured for the slot.
 *
 * The result is not validated against the schema; callers validate it. Malformed
 * output surfaces as `SyntaxError` (Codex) or `NoObjectGeneratedError` (AI SDK),
 * both recognized by the lesson correction retry.
 */
export const generateStructuredOutput = async <T>({
  config,
  output,
  prompt,
  reasoningEffort,
  signal,
  slot,
  system,
  webSearch = false,
}: StructuredGenerationRequest): Promise<T> => {
  if (resolveAiProviderForSlot(config, slot) === 'codex') {
    const modelConfig = resolveTextModelConfig(config, slot);
    const response = await runCodexAppServerTurn({
      allowWebSearch: webSearch,
      developerInstructions: `${system} ${webSearch ? CODEX_WEB_ONLY_INSTRUCTION : CODEX_TOOL_FREE_INSTRUCTION}`,
      input: [{ text: prompt, type: 'text' }],
      model: modelConfig.model,
      outputSchema: output.schema,
      reasoningEffort: reasoningEffort ?? modelConfig.reasoningEffort,
      serviceTier: resolveCodexServiceTierForSlot(config, slot),
      signal,
    });
    return JSON.parse(response) as T;
  }

  const configured = createConfiguredTextModel(config, slot, { reasoningEffort, webSearch });
  const result = await generateText({
    abortSignal: signal,
    maxRetries: 0,
    model: configured.model,
    output: Output.object({
      name: output.name,
      schema: jsonSchema<T>(output.schema as Parameters<typeof jsonSchema>[0]),
    }),
    prompt,
    providerOptions: configured.providerOptions,
    system,
    ...(configured.tools ? { tools: configured.tools } : {}),
  });
  return result.output;
};
