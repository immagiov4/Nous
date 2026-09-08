import type { AccountUsageSummary } from '@shared/accountUsage.js';
import * as z from 'zod';

export interface AccountUsageGroup {
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reportedCostUsd: number | null;
  calls: number;
  firstRecordedAt: string;
  lastRecordedAt: string;
}

const PriceSchema = z
  .string()
  .refine(value => value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0)
  .transform(Number);
const TokenRatesSchema = z.object({
  prompt: PriceSchema,
  completion: PriceSchema,
  input_cache_read: PriceSchema.optional(),
  input_cache_write: PriceSchema.optional(),
});
const ModelPriceSchema = z.object({
  id: z.string(),
  architecture: z.object({ output_modalities: z.array(z.string()) }),
  pricing: TokenRatesSchema.extend({
    overrides: z
      .array(TokenRatesSchema.partial().extend({ min_prompt_tokens: z.number().nonnegative() }))
      .optional(),
  }),
});
export type ModelPrice = z.infer<typeof ModelPriceSchema>;

/** Prices are read for the current estimate, never used to reconstruct a historical invoice. */
export const loadCurrentModelPrices = async (): Promise<ModelPrice[]> => {
  const response = await fetch('https://openrouter.ai/api/v1/models');
  if (!response.ok) throw new Error('Model pricing unavailable.');
  const body = z.object({ data: z.array(z.unknown()) }).parse(await response.json());
  return body.data.flatMap(value => {
    const parsed = ModelPriceSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
};

export const estimateRecordedTokenCost = (
  group: AccountUsageGroup,
  model: ModelPrice | undefined
): number | null => {
  if (
    !model ||
    group.provider !== 'openrouter' ||
    model.architecture.output_modalities.length !== 1 ||
    model.architecture.output_modalities[0] !== 'text' ||
    group.inputTokens === null ||
    group.outputTokens === null
  )
    return null;
  const override = model.pricing.overrides
    ?.filter(rate => group.inputTokens !== null && group.inputTokens >= rate.min_prompt_tokens)
    .sort((left, right) => right.min_prompt_tokens - left.min_prompt_tokens)[0];
  const rates = { ...model.pricing, ...override };
  // A missing cache counter is unknown, not evidence of zero discounted/premium tokens.
  if (
    (rates.input_cache_read !== undefined && group.cacheReadTokens === null) ||
    (rates.input_cache_write !== undefined && group.cacheWriteTokens === null)
  )
    return null;
  const cacheRead = group.cacheReadTokens ?? 0;
  const cacheWrite = group.cacheWriteTokens ?? 0;
  if (
    (cacheRead > 0 && rates.input_cache_read === undefined) ||
    (cacheWrite > 0 && rates.input_cache_write === undefined) ||
    cacheRead + cacheWrite > group.inputTokens
  )
    return null;
  return (
    group.calls *
    ((group.inputTokens - cacheRead - cacheWrite) * rates.prompt +
      cacheRead * (rates.input_cache_read ?? 0) +
      cacheWrite * (rates.input_cache_write ?? 0) +
      group.outputTokens * rates.completion)
  );
};

export const summarizeAccountUsage = (
  groups: readonly AccountUsageGroup[],
  prices: readonly ModelPrice[],
  ratesCheckedAt: string | null
): AccountUsageSummary => {
  const modelPrices = new Map(prices.map(model => [model.id, model]));
  const result: AccountUsageSummary = {
    recordedCalls: 0,
    tokens: null,
    missingTokenCalls: 0,
    reportedCostUsd: null,
    estimatedCostUsd: null,
    missingCostCalls: 0,
    firstRecordedAt: null,
    lastRecordedAt: null,
    ratesCheckedAt,
  };
  for (const group of groups) {
    result.recordedCalls += group.calls;
    if (group.inputTokens !== null || group.outputTokens !== null) {
      result.tokens =
        (result.tokens ?? 0) + ((group.inputTokens ?? 0) + (group.outputTokens ?? 0)) * group.calls;
    }
    if (group.inputTokens === null || group.outputTokens === null)
      result.missingTokenCalls += group.calls;
    if (group.reportedCostUsd !== null)
      result.reportedCostUsd = (result.reportedCostUsd ?? 0) + group.reportedCostUsd;
    else {
      const estimated = estimateRecordedTokenCost(group, modelPrices.get(group.model));
      if (estimated === null) result.missingCostCalls += group.calls;
      else result.estimatedCostUsd = (result.estimatedCostUsd ?? 0) + estimated;
    }
    if (result.firstRecordedAt === null || group.firstRecordedAt < result.firstRecordedAt)
      result.firstRecordedAt = group.firstRecordedAt;
    if (result.lastRecordedAt === null || group.lastRecordedAt > result.lastRecordedAt)
      result.lastRecordedAt = group.lastRecordedAt;
  }
  return result;
};
