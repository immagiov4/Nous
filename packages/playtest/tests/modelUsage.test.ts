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
import { createModelUsage, meterModel, withModelUsage } from '../src/modelUsage';

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
