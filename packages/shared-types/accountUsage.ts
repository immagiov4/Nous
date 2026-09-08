import * as z from 'zod';

export const AccountUsageSummarySchema = z.object({
  recordedCalls: z.number().int().nonnegative(),
  tokens: z.number().nonnegative().nullable(),
  missingTokenCalls: z.number().int().nonnegative(),
  reportedCostUsd: z.number().nonnegative().nullable(),
  estimatedCostUsd: z.number().nonnegative().nullable(),
  missingCostCalls: z.number().int().nonnegative(),
  hasCostEstimateCandidates: z.boolean(),
  firstRecordedAt: z.string().nullable(),
  lastRecordedAt: z.string().nullable(),
  ratesCheckedAt: z.string().nullable(),
});

export type AccountUsageSummary = z.infer<typeof AccountUsageSummarySchema>;
