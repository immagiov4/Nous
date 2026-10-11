import type { Api, Model } from '@mariozechner/pi-ai';
import type { ModelRegistry } from '@mariozechner/pi-coding-agent';
import * as z from 'zod';
import { meterModel, type PricedModel, TOKENS_PER_MILLION } from '../modelUsage';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const priceSchema = z.string().trim().min(1).pipe(z.coerce.number<string>().nonnegative());
const entrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  context_length: z.number().int().positive(),
  architecture: z.object({ input_modalities: z.array(z.string()) }),
  pricing: z.object({
    prompt: priceSchema,
    completion: priceSchema,
    input_cache_read: priceSchema.optional(),
    input_cache_write: priceSchema.optional(),
    overrides: z.array(z.unknown()).optional(),
  }),
  top_provider: z.object({ max_completion_tokens: z.number().int().positive() }),
  supported_parameters: z.array(z.string()).optional(),
});
const catalogueSchema = z.object({ data: z.array(z.object({ id: z.string() }).passthrough()) });

/** Only text/image inputs are supported by Pi; prices are expressed per million tokens. */
export function mapOpenRouterModel(entry: unknown): PricedModel<'openai-completions'> {
  const metadata = entrySchema.parse(entry);
  const input = metadata.architecture.input_modalities.filter(
    (modality): modality is 'text' | 'image' => modality === 'text' || modality === 'image'
  );
  if (input.length === 0)
    throw new Error(`No Pi-compatible input for OpenRouter model: ${metadata.id}`);
  return {
    id: metadata.id,
    name: metadata.name,
    provider: 'openrouter',
    api: 'openai-completions',
    baseUrl: OPENROUTER_BASE_URL,
    reasoning: metadata.supported_parameters?.includes('reasoning') ?? false,
    input,
    cost: {
      input: metadata.pricing.prompt * TOKENS_PER_MILLION,
      output: metadata.pricing.completion * TOKENS_PER_MILLION,
      // An absent cache tariff has no published cost; token limits must be supplied explicitly.
      cacheRead: (metadata.pricing.input_cache_read ?? 0) * TOKENS_PER_MILLION,
      cacheWrite: (metadata.pricing.input_cache_write ?? 0) * TOKENS_PER_MILLION,
    },
    contextWindow: metadata.context_length,
    maxTokens: metadata.top_provider.max_completion_tokens,
    pricingOverrides: metadata.pricing.overrides ?? [],
  };
}

async function fetchOpenRouterCatalogue(): Promise<unknown> {
  const response = await fetch(`${OPENROUTER_BASE_URL}/models`);
  if (!response.ok) throw new Error(`OpenRouter catalogue request failed: HTTP ${response.status}`);
  return response.json();
}

type ModelResolutionOptions = {
  provider: string;
  model: string;
  registry: Pick<ModelRegistry, 'find'>;
  fetchCatalogue?: () => Promise<unknown>;
};

async function resolveModel(options: ModelResolutionOptions): Promise<Model<Api>> {
  const registered = options.registry.find(options.provider, options.model);
  if (
    registered &&
    (options.provider !== 'openrouter' ||
      (registered as PricedModel).pricingOverrides !== undefined)
  )
    return registered;
  if (options.provider === 'openrouter') {
    const catalogue = catalogueSchema.parse(
      await (options.fetchCatalogue ?? fetchOpenRouterCatalogue)()
    );
    const entry = catalogue.data.find(candidate => candidate.id === options.model);
    if (entry) return mapOpenRouterModel(entry);
  }
  throw new Error(`Unknown Pi model: ${options.provider}/${options.model}`);
}

/** A source shares one lazy resolution, including concurrent callers and resolution failures. */
export function createModelResolver(options: ModelResolutionOptions): () => Promise<Model<Api>> {
  let resolution: Promise<Model<Api>> | undefined;
  return async () => {
    resolution ??= resolveModel(options);
    return meterModel(await resolution);
  };
}
