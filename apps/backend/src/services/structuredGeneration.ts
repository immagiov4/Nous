import { generateText, jsonSchema, Output } from 'ai';

import {
  type AiProvider,
  type GlobalModelConfig,
  type ReasoningEffort,
  resolveAiProviderForSlot,
  resolveCodexServiceTierForSlot,
  resolveTextModelConfig,
  type TextModelSlot,
} from '../config/modelConfig.js';
import { createConfiguredTextModelFromResolution } from './aiSdkTextModel.js';
import { runCodexAppServerTurn } from './codexAppServer.js';

/** JSON Schema of a structured model response, named for providers that require it. */
export interface StructuredOutputSchema {
  readonly name: string;
  readonly schema: Record<string, unknown>;
}

/** A provider and model fixed ahead of the call, for example in durable workflow state. */
export interface ResolvedStructuredModel {
  readonly model: string;
  readonly provider: AiProvider;
  readonly reasoningEffort: ReasoningEffort;
  readonly serviceTier?: 'fast';
}

/** Selects the model by slot from the current configuration, or uses a resolved one. */
export type StructuredModelTarget =
  | { readonly config: GlobalModelConfig; readonly slot: TextModelSlot }
  | { readonly model: ResolvedStructuredModel };

export type StructuredGenerationRequest = StructuredModelTarget & {
  /** Data URL of one image shown to the model before the prompt. */
  readonly image?: string;
  /** AI SDK transport retries; 0 by default because callers own correction retries. */
  readonly maxRetries?: number;
  readonly output: StructuredOutputSchema;
  readonly prompt: string;
  /** Overrides the slot's configured reasoning effort. */
  readonly reasoningEffort?: ReasoningEffort;
  readonly signal: AbortSignal;
  readonly system: string;
  /** Lets the model search the web; local tools and files stay forbidden. */
  readonly webSearch?: boolean;
};

// The Codex app-server runs an agent with tools and a workspace; structured
// generation needs a single schema-bound answer, so the turn forbids local
// access and every tool except an explicitly requested web search.
const CODEX_TOOL_FREE_INSTRUCTION = 'Do not use tools or access local files.';
const CODEX_WEB_ONLY_INSTRUCTION = 'Do not access local files.';

const resolveTarget = (request: StructuredGenerationRequest): ResolvedStructuredModel => {
  if ('model' in request) return request.model;
  const { config, reasoningEffort, slot } = request;
  const provider = resolveAiProviderForSlot(config, slot);
  const resolved = resolveTextModelConfig(config, slot);
  const serviceTier =
    provider === 'codex' ? resolveCodexServiceTierForSlot(config, slot) : undefined;
  return {
    model: resolved.model,
    provider,
    reasoningEffort: reasoningEffort ?? resolved.reasoningEffort,
    ...(serviceTier ? { serviceTier } : {}),
  };
};

/**
 * Generates one schema-bound response with the configured or resolved provider.
 *
 * The result is not validated against the schema; callers validate it. Malformed
 * output surfaces as `SyntaxError` (Codex) or `NoObjectGeneratedError` (AI SDK),
 * both recognized by the lesson correction retry.
 */
export const generateStructuredOutput = async <T>(
  request: StructuredGenerationRequest
): Promise<T> => {
  const { image, maxRetries = 0, output, prompt, signal, system, webSearch = false } = request;
  const target = resolveTarget(request);
  if (target.provider === 'codex') {
    const response = await runCodexAppServerTurn({
      allowWebSearch: webSearch,
      developerInstructions: `${system} ${webSearch ? CODEX_WEB_ONLY_INSTRUCTION : CODEX_TOOL_FREE_INSTRUCTION}`,
      input: [
        ...(image ? [{ type: 'image' as const, url: image }] : []),
        { text: prompt, type: 'text' },
      ],
      model: target.model,
      outputSchema: output.schema,
      reasoningEffort: target.reasoningEffort,
      serviceTier: target.serviceTier,
      signal,
    });
    return JSON.parse(response) as T;
  }

  const configured = createConfiguredTextModelFromResolution(
    { model: target.model, provider: target.provider, reasoningEffort: target.reasoningEffort },
    { webSearch }
  );
  const result = await generateText({
    abortSignal: signal,
    maxRetries,
    model: configured.model,
    output: Output.object({
      name: output.name,
      schema: jsonSchema<T>(output.schema as Parameters<typeof jsonSchema>[0]),
    }),
    ...(image
      ? {
          messages: [
            {
              content: [
                { image, type: 'image' as const },
                { text: prompt, type: 'text' as const },
              ],
              role: 'user' as const,
            },
          ],
        }
      : { prompt }),
    providerOptions: configured.providerOptions,
    system,
    ...(configured.tools ? { tools: configured.tools } : {}),
  });
  return result.output;
};
