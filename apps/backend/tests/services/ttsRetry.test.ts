import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getRetryDecision, toStepFailure } from '../../src/workflows/retryPolicy.js';

vi.mock('../../src/config/chatConfig.js', () => ({ requireOpenRouterApiKey: () => 'test-key' }));
const { ttsClient } = await import('../../src/services/ttsClient.js');
const NOW = Date.parse('2026-10-22T12:00:00Z');
const request = { text: 'Synthetic narration.', model: 'x-ai/grok-voice-tts-1.0', voice: 'Ara' };
const fetchMock = vi.fn<typeof fetch>();

const speechFailure = async (headers: Record<string, string>, status = 429) => {
  fetchMock.mockResolvedValueOnce(
    new Response('{"error":{"message":"Rate limited"}}', { status, headers })
  );
  try {
    await ttsClient.generateSpeech(request);
    throw new Error('Expected speech to fail.');
  } catch (error) {
    expect(error).toMatchObject({ name: 'OpenRouterTtsError', status });
    return error;
  }
};

describe('TTS response to workflow retry decision', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test.each([
    ['seconds', { 'retry-after': '12' }, 12_000],
    ['HTTP date', { 'retry-after': new Date(NOW + 12_000).toUTCString() }, 12_000],
    ['short hint', { 'retry-after': '1' }, 2_500],
    ['absent hint', {}, 2_500],
    ['invalid hint', { 'retry-after': 'not-a-date' }, 2_500],
    ['past date', { 'retry-after': new Date(NOW - 12_000).toUTCString() }, 2_500],
    ['cap boundary', { 'retry-after': '30' }, 30_000],
  ])('uses %s with the existing backoff', async (_label, headers, delayMs) => {
    const error = await speechFailure(headers);
    const failure = toStepFailure(error);
    expect(
      getRetryDecision({ failure, attemptNumber: 1, maxAttempts: 3, random: () => 1 })
    ).toEqual({ retry: true, delayMs });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each([429, 503])('stops immediately above the cap for HTTP %s', async status => {
    const failure = toStepFailure(await speechFailure({ 'retry-after': '45' }, status));
    expect(getRetryDecision({ failure, attemptNumber: 1, maxAttempts: 3 })).toEqual({
      retry: false,
    });
  });

  test('preserves retry and rate-limit reset metadata on the speech error', async () => {
    const responseHeaders = { 'retry-after': '12', 'x-ratelimit-reset': String(NOW + 12_000) };
    expect(await speechFailure(responseHeaders)).toMatchObject({ responseHeaders });
  });

  test.each([
    {},
    { 'retry-after': '12' },
  ])('preserves retry behavior for 5xx with %j', async headers => {
    const failure = toStepFailure(await speechFailure(headers, 503));
    expect(
      getRetryDecision({ failure, attemptNumber: 2, maxAttempts: 3, random: () => 0 })
    ).toEqual({ retry: true, delayMs: headers['retry-after'] ? 12_000 : 4_000 });
  });

  test('does not schedule a wait after the last attempt', async () => {
    const failure = toStepFailure(await speechFailure({ 'retry-after': '12' }));
    const random = vi.fn();
    expect(getRetryDecision({ failure, attemptNumber: 3, maxAttempts: 3, random })).toEqual({
      retry: false,
    });
    expect(random).not.toHaveBeenCalled();
  });

  test('returns successful speech without scheduling a timer', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    fetchMock.mockResolvedValueOnce(
      new Response(bytes, { headers: { 'content-type': 'audio/mpeg' } })
    );
    expect(new Uint8Array((await ttsClient.generateSpeech(request)).audioBuffer)).toEqual(bytes);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
