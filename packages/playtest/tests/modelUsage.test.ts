import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  registerApiProvider,
  streamSimple,
  unregisterApiProviders,
} from '@mariozechner/pi-ai';
import { afterAll, expect, it, vi } from 'vitest';
import { mapOpenRouterModel } from '../src/learner/modelResolution';
import { createModelUsage, meterModel, withModelUsage } from '../src/modelUsage';
import tieredEntry from './fixtures/models/openrouter-sonnet-4.json';

const api = 'synthetic-playtest-usage';
const model: Model<Api> = {
  id: 'synthetic',
  name: 'Synthetic',
  provider: 'synthetic',
  api,
  baseUrl: 'https://synthetic.invalid',
  reasoning: false,
  input: ['text'],
  contextWindow: 1,
  maxTokens: 1,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const message: AssistantMessage = {
  role: 'assistant',
  content: [],
  api,
  provider: 'synthetic',
  model: 'synthetic',
  stopReason: 'stop',
  timestamp: 0,
  usage: {
    input: 10,
    output: 2,
    cacheRead: 3,
    cacheWrite: 1,
    totalTokens: 16,
    cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
  },
};
const syntheticStream = () => {
  const events = createAssistantMessageEventStream();
  queueMicrotask(() => {
    events.push({ type: 'done', reason: 'stop', message });
    events.end(message);
  });
  return events;
};
registerApiProvider({ api, stream: syntheticStream, streamSimple: syntheticStream }, api);
afterAll(() => {
  unregisterApiProviders(api);
  unregisterApiProviders(`playtest-usage:${api}`);
});

it('records final Pi usage once, preserves stream events and separates concurrent stories and phases', async () => {
  const first = createModelUsage();
  const second = createModelUsage();
  const call = (report: typeof first, phase: 'learner' | 'judge') =>
    withModelUsage(report, phase, async () => {
      const events = streamSimple(meterModel(model), { messages: [] }, { apiKey: 'synthetic' });
      const received = [];
      for await (const event of events) received.push(event);
      expect(received).toEqual([{ type: 'done', reason: 'stop', message }]);
      expect(await events.result()).toEqual(message);
    });
  await Promise.all([call(first, 'learner'), call(first, 'judge'), call(second, 'learner')]);
  expect(first.total.responses).toBe(2);
  expect(first.total.totalTokens).toBe(32);
  expect(first.total.cost.total).toBeCloseTo(0.2);
  expect(first.learner).toEqual({ ...message.usage, responses: 1 });
  expect(first.judge).toEqual({ ...message.usage, responses: 1 });
  expect(second.total).toEqual({ ...message.usage, responses: 1 });
  expect(second.judge.responses).toBe(0);
  expect(meterModel(model)).toBe(model);
});

it('handles rejected stream results without recording fabricated usage', async () => {
  const events = createAssistantMessageEventStream();
  const failure = new Error('Synthetic provider failure');
  vi.spyOn(events, 'result').mockImplementation(() => Promise.reject(failure));
  registerApiProvider({ api, stream: () => events, streamSimple: () => events }, api);
  unregisterApiProviders(`playtest-usage:${api}`);
  const report = createModelUsage();
  await withModelUsage(report, 'learner', async () => {
    const stream = streamSimple(meterModel(model), { messages: [] }, { apiKey: 'synthetic' });
    await expect(stream.result()).rejects.toThrow(failure);
  });
  expect(report.total.responses).toBe(0);
  expect(report.total.totalTokens).toBe(0);
});

async function priceRequest(
  promptTokens: number,
  entry: unknown = tieredEntry,
  report = createModelUsage()
) {
  const usage = {
    ...message.usage,
    input: promptTokens - 30,
    cacheRead: 20,
    cacheWrite: 10,
    output: 2,
    totalTokens: promptTokens + 2,
    cost: { ...message.usage.cost },
  };
  unregisterApiProviders(`playtest-usage:${api}`);
  const response = { ...message, usage };
  const stream = () => {
    const events = createAssistantMessageEventStream();
    queueMicrotask(() => {
      events.push({ type: 'done', reason: 'stop', message: response });
      events.end(response);
    });
    return events;
  };
  registerApiProvider({ api, stream, streamSimple: stream }, api);
  await withModelUsage(report, 'learner', async () => {
    await streamSimple(
      meterModel({ ...mapOpenRouterModel(entry), api }),
      { messages: [] },
      { apiKey: 'synthetic' }
    ).result();
  });
  return report;
}

it.each([
  -1, 0, 1,
])('applies the Sonnet tier per request at threshold %+i, including cached prompt tokens', async offset => {
  const threshold = tieredEntry.pricing.overrides[0].min_prompt_tokens;
  const promptTokens = threshold + offset;
  const report = await priceRequest(promptTokens);
  const rates = offset <= 0 ? tieredEntry.pricing : tieredEntry.pricing.overrides[0];
  const cost = report.requests[0].usage.cost;
  expect(cost.input).toBeCloseTo((promptTokens - 30) * Number(rates.prompt));
  expect(cost.output).toBeCloseTo(2 * Number(rates.completion));
  expect(cost.cacheRead).toBeCloseTo(20 * Number(rates.input_cache_read));
  expect(cost.cacheWrite).toBeCloseTo(10 * Number(rates.input_cache_write));
  expect(cost.total).toBeCloseTo(cost.input + cost.output + cost.cacheRead + cost.cacheWrite);
  expect(report.total.cost).toEqual(cost);
  expect(report.costEstimated).toBeUndefined();
});

it('selects tiers per request instead of accumulated story prompt tokens', async () => {
  const promptTokens = tieredEntry.pricing.overrides[0].min_prompt_tokens - 1;
  const report = await priceRequest(promptTokens);
  await priceRequest(promptTokens, tieredEntry, report);
  expect(report.total.responses).toBe(2);
  expect(report.total.cost.total).toBeCloseTo(report.requests[0].usage.cost.total * 2);
  expect(report.requests[1].usage.cost).toEqual(report.requests[0].usage.cost);
});

it('uses base rates and marks the request and aggregate estimated for an unknown condition', async () => {
  const unknownEntry = {
    ...tieredEntry,
    pricing: {
      ...tieredEntry.pricing,
      overrides: [{ ...tieredEntry.pricing.overrides[0], utc_start: '09:00' }],
    },
  };
  const promptTokens = tieredEntry.pricing.overrides[0].min_prompt_tokens + 1;
  const report = await priceRequest(promptTokens, unknownEntry);
  const request = report.requests[0];
  expect(request.costEstimated).toBe(true);
  expect(report.costEstimated).toBe(true);
  expect(request.usage.cost.input).toBeCloseTo(
    (promptTokens - 30) * Number(tieredEntry.pricing.prompt)
  );
  expect(request.usage.cost.output).toBeCloseTo(2 * Number(tieredEntry.pricing.completion));
  await priceRequest(promptTokens, tieredEntry, report);
  expect(report.requests[1].costEstimated).toBeUndefined();
  expect(report.costEstimated).toBe(true);
});

it('applies matching overrides in catalogue order with later rates winning per key', async () => {
  const tier = tieredEntry.pricing.overrides[0];
  const entry = {
    ...tieredEntry,
    pricing: {
      ...tieredEntry.pricing,
      overrides: [tier, { min_prompt_tokens: tier.min_prompt_tokens, prompt: '0.000009' }],
    },
  };
  const report = await priceRequest(tier.min_prompt_tokens + 1, entry);
  expect(report.requests[0].usage.cost.input).toBeCloseTo(
    (tier.min_prompt_tokens + 1 - 30) * 0.000009
  );
});
