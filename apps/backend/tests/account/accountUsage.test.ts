import { describe, expect, test, vi } from 'vitest';
import {
  type AccountUsageGroup,
  estimateRecordedTokenCost,
  loadCurrentModelPrices,
  type ModelPrice,
  summarizeAccountUsage,
} from '../../src/account/accountUsage.js';

const group: AccountUsageGroup = {
  provider: 'openrouter',
  model: 'example/text',
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 30,
  cacheWriteTokens: 10,
  reportedCostUsd: null,
  calls: 2,
  firstRecordedAt: '2026-09-01T12:00:00Z',
  lastRecordedAt: '2026-09-02T12:00:00Z',
};
const model: ModelPrice = {
  id: group.model,
  architecture: { output_modalities: ['text'] },
  pricing: { prompt: 0.01, completion: 0.02, input_cache_read: 0.001, input_cache_write: 0.0125 },
};

describe('account recorded usage', () => {
  test.each([
    { provider: 'codex', reportedCostUsd: null, expected: false },
    { provider: 'openai', reportedCostUsd: null, expected: false },
    { provider: 'openrouter', reportedCostUsd: null, expected: true },
    { provider: 'openrouter', reportedCostUsd: 0, expected: false },
  ])('identifies price-lookup candidates without promising a computed cost: %j', ({
    provider,
    reportedCostUsd,
    expected,
  }) => {
    const summary = summarizeAccountUsage([{ ...group, provider, reportedCostUsd }], [], null);
    expect(summary.hasCostEstimateCandidates).toBe(expected);
    expect(summary.estimatedCostUsd).toBeNull();
  });

  test('counts cached input once and uses exclusive input portions for pricing', () => {
    const result = summarizeAccountUsage([group], [model], '2026-09-08');
    expect(result.tokens).toBe(240);
    expect(result.estimatedCostUsd).toBeCloseTo(
      2 * (60 * 0.01 + 30 * 0.001 + 10 * 0.0125 + 20 * 0.02)
    );
    expect(result.missingCostCalls).toBe(0);
  });

  test('provider cost, including zero, takes precedence over current estimates', () => {
    const result = summarizeAccountUsage(
      [
        { ...group, reportedCostUsd: 0 },
        { ...group, reportedCostUsd: 0.7 },
      ],
      [model],
      null
    );
    expect(result.reportedCostUsd).toBe(0.7);
    expect(result.estimatedCostUsd).toBeNull();
  });

  test('preserves missing counters and incomplete totals instead of inventing zeros', () => {
    const result = summarizeAccountUsage(
      [
        { ...group, inputTokens: null, outputTokens: 20 },
        { ...group, inputTokens: null, outputTokens: null },
      ],
      [model],
      null
    );
    expect(result.tokens).toBe(40);
    expect(result.missingTokenCalls).toBe(4);
    expect(result.estimatedCostUsd).toBeNull();
    expect(result.missingCostCalls).toBe(4);
    expect(summarizeAccountUsage([], [], null)).toMatchObject({
      recordedCalls: 0,
      tokens: null,
      reportedCostUsd: null,
      estimatedCostUsd: null,
    });
  });

  test.each([
    { cacheReadTokens: null },
    { cacheWriteTokens: null },
    { cacheReadTokens: 101 },
    { provider: 'codex' },
    { provider: 'openai' },
  ])('does not estimate when billing counters or provider pricing are unsupported: %j', changes => {
    expect(estimateRecordedTokenCost({ ...group, ...changes }, model)).toBeNull();
  });

  test('does not price image output as text tokens', () => {
    expect(
      estimateRecordedTokenCost(group, {
        ...model,
        architecture: { output_modalities: ['text', 'image'] },
      })
    ).toBeNull();
  });

  test('applies the provider long-context bracket per call, never by aggregated tokens', () => {
    const bracketModel = {
      ...model,
      pricing: { ...model.pricing, overrides: [{ min_prompt_tokens: 150, prompt: 0.03 }] },
    };
    expect(estimateRecordedTokenCost(group, bracketModel)).toBe(
      estimateRecordedTokenCost(group, model)
    );
    expect(estimateRecordedTokenCost({ ...group, inputTokens: 150 }, bracketModel)).toBe(
      estimateRecordedTokenCost({ ...group, inputTokens: 150 }, model)
    );
    expect(estimateRecordedTokenCost({ ...group, inputTokens: 151 }, bracketModel)).toBeCloseTo(
      2 * (111 * 0.03 + 30 * 0.001 + 10 * 0.0125 + 20 * 0.02)
    );
  });

  test('applies later matching price entries per key without discarding earlier keys', () => {
    const overrides = [
      { min_prompt_tokens: 10, prompt: 0.03 },
      { min_prompt_tokens: 20, completion: 0.04 },
      { min_prompt_tokens: 5, prompt: 0.05 },
    ];
    expect(
      estimateRecordedTokenCost(group, { ...model, pricing: { ...model.pricing, overrides } })
    ).toBeCloseTo(2 * (60 * 0.05 + 30 * 0.001 + 10 * 0.0125 + 20 * 0.04));
  });

  test('leaves models with unsupported time-dependent prices unpriced', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          data: [
            {
              id: 'time-window',
              architecture: { output_modalities: ['text'] },
              pricing: {
                prompt: '0.01',
                completion: '0.02',
                overrides: [
                  { min_prompt_tokens: 10, utc_start: 100, utc_end: 400, prompt: '0.03' },
                ],
              },
            },
          ],
        })
      )
    );
    try {
      expect(await loadCurrentModelPrices()).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
